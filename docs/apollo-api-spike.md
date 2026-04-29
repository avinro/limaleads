# Apollo API Spike — Findings & Decisions

**Issue:** AVI-5  
**Date:** 2026-04-29  
**Status:** GO

---

## 1. API Endpoint for Fetching People/Leads

Apollo uses a **two-step flow** to get fully enriched leads:

### Step 1 — Search (no credits consumed)

```
POST https://api.apollo.io/api/v1/mixed_people/api_search
```

- Requires a **master API key** (header: `x-api-key`). A regular key returns 403.
- Returns a list of matching people with obfuscated data (no email, no full last name).
- Use this to get Apollo `id` values before enriching.

**Critical limitation:** This endpoint does **not** return `email`, full `last_name`, or `linkedin_url`. Those fields require the Enrichment step.

Response shape per person:
```json
{
  "id": "67bdafd0...",
  "first_name": "Andrew",
  "last_name_obfuscated": "Hu***n",
  "title": "Professor...",
  "last_refreshed_at": "2025-11-04T23:20:32.690+00:00",
  "has_email": true,
  "organization": {
    "name": "Scicomm Media"
  }
}
```

**Only enrich people where `has_email: true`** — otherwise the enrichment call wastes a credit and will return no email.

### Step 2 — Enrich (consumes credits)

```
POST https://api.apollo.io/api/v1/people/match
```

Pass the Apollo `id` from Step 1 to get the full record:

```
?id=67bdafd0...
```

Returns:
```json
{
  "person": {
    "id": "64a7ff0c...",
    "first_name": "Tim",
    "last_name": "Zheng",
    "name": "Tim Zheng",
    "email": "tim@apollo.io",
    "email_status": "verified",
    "title": "Founder & CEO",
    "linkedin_url": "http://www.linkedin.com/in/tim-zheng-677ba010",
    "organization": {
      "name": "Apollo"
    }
  }
}
```

---

## 2. Pagination Strategy

Pagination is **offset-based** (not cursor-based):

| Parameter | Description                  | Default | Max |
|-----------|------------------------------|---------|-----|
| `page`    | Page number (1-indexed)      | 1       | 500 |
| `per_page`| Results per page             | 25      | 100 |

**Total display limit:** 50,000 records (100 results × 500 pages).  
To access more data, apply narrower filters.

### "New leads since last run" strategy

Apollo does **not** expose a native creation date or "added after" filter.

**Decision:** Use Supabase deduplication as the source of truth.

- On every poll, search with the same filters and paginate from page 1.
- For each result with `has_email: true`, attempt `INSERT INTO leads ... ON CONFLICT (email) DO NOTHING`.
- New leads get inserted; already-seen leads are silently skipped.
- Use `last_refreshed_at` from the search response only as a last-resort optimization (e.g., skip enrichment if refreshed > 30 days ago and already in DB).

This approach is simpler and more reliable than tracking cursors or Apollo-side timestamps.

---

## 3. Available Filters (source_criteria mapping)

The following filters are available on the Search endpoint and map to our `source_criteria` field:

| Filter parameter                        | Description                                    |
|-----------------------------------------|------------------------------------------------|
| `person_titles[]`                       | Job titles (fuzzy match by default)            |
| `include_similar_titles`                | `false` = exact title match only               |
| `person_seniorities[]`                  | `owner`, `founder`, `c_suite`, `vp`, `director`, `manager`, `senior`, `entry`, `intern` |
| `person_locations[]`                    | Personal city / state / country                |
| `organization_locations[]`              | Company HQ city / state / country              |
| `organization_num_employees_ranges[]`   | e.g. `"10,50"`, `"51,200"`                    |
| `contact_email_status[]`                | `verified`, `unverified`, `likely to engage`   |
| `q_organization_domains_list[]`         | Filter by company domain (up to 1,000)         |
| `currently_using_any_of_technology_uids[]` | Tech stack filter (1,500+ technologies)    |
| `revenue_range[min]` / `[max]`          | Company revenue range in USD                  |
| `q_keywords`                            | Free-text keyword search                       |

**Recommendation:** Store the exact filter object used per poll run as a JSON blob in `source_criteria` on the `leads` table. This makes auditing and replication straightforward.

---

## 4. Rate Limits

| Endpoint                          | Limit (from live 429 response) |
|-----------------------------------|-------------------------------|
| `mixed_people/api_search`         | **600 requests/hour** (~10/min) |
| `people/match` (enrichment)       | Not explicitly stated; credits apply |

> **Important correction vs. PRD assumption:** The PRD estimated 50 req/min (3,000/hour) for the Basic plan. The actual 429 error message from the API confirms the Search endpoint allows **600 requests/hour** on the current plan. This is sufficient for our 4-hour polling cadence.

### Usage pattern analysis

A single poll run with filters may return ~100–500 matching leads per page.  
At 100 results/page and a 4h cadence:

- Pages fetched per run: typically 1–5 (500–2,500 unique leads in the ICP)
- Enrichment calls per run: ≤ count of `has_email: true` results (likely 60–80% of results)
- Total calls per 4h window: ~5 search + ~400 enrichment = **well within 600/hour**

No rate-limit risk at MVP volume.

---

## 5. Field Availability

| PRD field       | Available in Search | Available in Enrichment | Notes                                              |
|-----------------|--------------------|--------------------------|----------------------------------------------------|
| `email`         | No                 | **Yes** (`email`)        | Only when `has_email: true` in search result       |
| `name`          | Partial (first name only, last name obfuscated) | **Yes** (`name`, `first_name`, `last_name`) | |
| `company`       | **Yes** (`organization.name`) | **Yes** (`organization.name`) | |
| `title`         | **Yes** (may be `null`) | **Yes** (may be `null`) | |
| `linkedin_url`  | No                 | **Yes** (`linkedin_url`) | May be `null` for some profiles                   |
| `apollo_id`     | **Yes** (`id`)     | **Yes** (`id`)           | Use as stable cross-reference key                 |

### Null field handling decisions

| Field          | When null/missing | Decision                                              |
|----------------|-------------------|-------------------------------------------------------|
| `email`        | Not enrichable    | **Skip lead entirely** — email is the dedup key and outreach target |
| `title`        | Null              | Store as `null`; Gemini prompt degrades gracefully (omit from context) |
| `linkedin_url` | Null              | Store as `null`; Gemini prompt omits LinkedIn section |
| `company`      | Null              | **Skip lead** — company is required for personalization |
| `name`         | Null              | Should not occur after enrichment; log warning if it does |

---

## 6. Deduplication Strategy

**Primary dedup key:** `email` (Supabase UNIQUE constraint).

```sql
INSERT INTO leads (email, name, company, title, linkedin_url, apollo_id, source_criteria, status)
VALUES (...)
ON CONFLICT (email) DO NOTHING;
```

**Behavior when an existing lead reappears:**
- `DO NOTHING` — the existing row and its status are preserved.
- The poller does not overwrite status, draft_id, or any tracking fields.
- If we later need to update stale profile data (e.g., job change), this can be added as a separate update path (out of scope for MVP).

**Additional guard:** Store `apollo_id` as a non-unique indexed column. A future query can detect if the same person reappears under a new email.

---

## 7. Go / No-Go Decision

**GO.**

All required fields are accessible via the two-step Search → Enrichment flow. The two-step approach is the standard Apollo API pattern and is well-documented.

### Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Credits exhausted by enrichment volume | Low at MVP scale | Filter by `has_email: true` before enriching; log credit usage in `job_log` |
| Search results exceed 50k limit | Low — filters will narrow results | Add more specific filters (`seniority`, `employee_range`) |
| Email not revealed by enrichment | Medium — `~20%` of `has_email: true` contacts still return null email | Skip and log; do not create a lead row |
| Rate limit hit | Very Low (600/hour, we use ~5/run) | Exponential backoff on 429; `job_log` tracks failures |
| `linkedin_url` missing | Medium | Already handled — field is nullable in schema |

### Open question for the team

The Search endpoint returns results sorted by Apollo's internal ranking — not by date. There is no `sort_by=created_at` option. Our deduplication-via-Supabase strategy handles this correctly, but the ops team should be aware that "new leads in Apollo" and "new leads inserted into Supabase" are not guaranteed to correspond 1:1 within a single polling window.
