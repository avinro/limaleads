# Gmail Draft-to-Sent Correlation Strategy

## Problem

When the rep sends a drafted outreach email, the Gmail API changes the message state in a non-obvious way:

- A **draft** has a `draftId` (e.g. `r1234567890`) and contains a **messageId** (the inner RFC 2822 message).
- When the draft is **sent**, Gmail creates a **new message** in the SENT label with a **new messageId** but the **same `threadId`**.
- The original `draftId` is invalidated immediately after sending.

This means we cannot track the send event by polling the draft's own ID. We need to correlate by `threadId` or message metadata.

## What We Store at Draft Creation (AVI-13)

The following columns are populated on the `leads` row when `createGmailDraft()` runs:

| Column | Description |
|---|---|
| `gmail_draft_id` | The Gmail draft container ID (`r…`) |
| `gmail_thread_id` | The `threadId` of the draft message |
| `draft_subject` | Subject line rendered at draft creation time |
| `draft_body` | Plain-text body rendered at draft creation time |

`draft_subject` and `draft_body` are the **original AI-generated content**. They are never overwritten after draft creation.

## Correlation Algorithm (`findSentMessageForLead`)

The function runs in two ordered strategies. It stops as soon as a valid match is found.

### Strategy 1 — Thread Lookup (preferred)

Requires `gmail_thread_id` to be set.

```
gmail.users.threads.get(threadId)
  ↓
Filter messages where:
  labelIds includes 'SENT'
  From header contains repEmail (from gmail.users.getProfile)
  To/Cc/Bcc header contains lead.email
  internalDate >= lead.created_at − 60 seconds
  ↓
Sort by internalDate ascending
Pick the earliest valid message
  ↓
Fetch full message body via messages.get(id, format='full')
  ↓
Return { messageId, threadId, sentAt, body, editedBeforeSend }
```

The 60-second tolerance on `internalDate` absorbs clock skew between our DB write and Gmail's internal timestamp.

### Strategy 2 — Subject Fallback

Used only when `gmail_thread_id` is null **and** `draft_subject` is set. This covers the case where the draft was created via a different code path that did not capture the thread ID.

```
gmail.users.messages.list({ q: 'in:sent subject:"<draft_subject>"', maxResults: 20 })
  ↓
For each candidate:
  Fetch metadata (From, To, Cc, Bcc headers)
  Validate From = repEmail
  Validate lead.email in To/Cc/Bcc
  internalDate >= lead.created_at − 60 seconds
  ↓
Sort by internalDate ascending, pick earliest
  ↓
Fetch full body, return result
```

If **both** `gmail_thread_id` and `draft_subject` are null, the function returns `null` immediately without issuing any Gmail API queries.

## Edit Detection

At the moment of correlation, the sent message body is compared to `lead.draft_body`:

1. Normalize both strings: collapse multiple spaces/tabs, normalize CRLF → LF, trim.
2. If normalized strings differ → `editedBeforeSend = true`.
3. If `draft_body` is null or blank → `editedBeforeSend = false` (no baseline to compare).

`editedBeforeSend` is returned in `SentMessageResult` but never written to Supabase by this function. AVI-19 (sent detection job) owns the write.

## Sender Validation

The rep's email address is resolved once via `gmail.users.getProfile().emailAddress` and cached for the process lifetime. This avoids requiring an explicit `GMAIL_SENDER_EMAIL` env var that could drift out of sync.

## Edge Cases

| Scenario | Behavior |
|---|---|
| Draft deleted without sending | Thread has no SENT messages from rep → returns `null` |
| Draft sent, then another email sent in the same thread | Recipient validation narrows to `lead.email`; earliest valid message after `created_at` wins |
| Rep sends from a different Gmail client (mobile, web) | Thread and SENT label APIs expose the message regardless of client → matches normally |
| `gmail_thread_id` is null, `draft_subject` is set | Falls back to subject search with From/To/date validation |
| `gmail_thread_id` and `draft_subject` are both null | Returns `null` immediately, no API calls made |
| `draft_body` is null | Correlation still works; edit detection returns `false` |
| SENT message addressed to someone else in the same thread | Recipient validation fails → message is ignored |

## Caller Contract (AVI-19)

`findSentMessageForLead` is a pure read function. After calling it, the sent detection job is responsible for:

1. Updating `leads.edited_before_send = result.editedBeforeSend`
2. Updating `leads.contacted_at = result.sentAt`
3. Calling `transitionLeadStatus(leadId, 'contacted', 'system')`

## Files

| File | Purpose |
|---|---|
| `src/integrations/gmailAuth.ts` | Shared OAuth2 client and `getRepSenderEmail()` cache |
| `src/integrations/gmailCorrelation.ts` | `findSentMessageForLead()` implementation |
| `src/integrations/gmailCorrelation.test.ts` | Unit tests (20 cases) |
| `supabase/migrations/avi-12_20260430180000_add_draft_snapshot.sql` | Adds `draft_subject`, `draft_body` to `leads` |
