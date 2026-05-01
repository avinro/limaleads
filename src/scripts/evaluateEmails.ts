// AVI-17 evaluation script — generates 20 email drafts from real enriched leads
// in Supabase and writes a markdown report for manual quality-gate review.
//
// The script queries the `leads` table for rows that have been enriched by
// the Apollo poller (company_hook IS NOT NULL, country IS NOT NULL). It picks
// a representative set of 20 leads across different industries before calling
// Gemini, so the output reflects real personalization diversity.
//
// The 80% gate (≥16/20 pass) must be met before merging to AVI-18.
//
// Usage: npm run eval:emails
//
// IMPORTANT: If this script exits with "Not enough enriched leads" you must
// first run `npm run apollo:poll` to populate enrichment data. Do NOT run
// `npm run pipeline:once` — it also triggers the Gmail draft job.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSupabaseClient } from '../db/client';
import { generateEmail, type LeadContext } from '../integrations/geminiClient';
import { detectLanguageFromCountry } from '../lib/language';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EVAL_SIZE = 20;
const CANDIDATE_POOL = 100; // Fetch more candidates than needed to allow diversity selection.

// ---------------------------------------------------------------------------
// DB query
// ---------------------------------------------------------------------------

interface EligibleLeadRow {
  id: string;
  name: string;
  title: string | null;
  company: string;
  country: string;
  company_hook: string;
  linkedin_url: string | null;
  source_criteria: string | null;
  industry: string | null;
}

async function fetchEligibleLeads(): Promise<EligibleLeadRow[]> {
  const { data, error } = await getSupabaseClient()
    .from('leads')
    .select(
      'id, name, title, company, country, company_hook, linkedin_url, source_criteria, industry',
    )
    .not('company_hook', 'is', null)
    .not('country', 'is', null)
    .not('name', 'is', null)
    .not('company', 'is', null)
    .not('email', 'is', null)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_POOL);

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  return (data ?? []) as EligibleLeadRow[];
}

// ---------------------------------------------------------------------------
// Diversity selection
// ---------------------------------------------------------------------------

/**
 * Picks up to `count` rows from `candidates` by spreading across unique
 * `industry` values in round-robin order. This prevents the eval from being
 * dominated by a single industry.
 *
 * Falls back gracefully when there are fewer industries than `count`.
 */
function selectDiverse(candidates: EligibleLeadRow[], count: number): EligibleLeadRow[] {
  // Group by industry (null → 'unknown')
  const byIndustry = new Map<string, EligibleLeadRow[]>();
  for (const lead of candidates) {
    const key = lead.industry ?? 'unknown';
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key)!.push(lead);
  }

  const buckets = [...byIndustry.values()];
  const selected: EligibleLeadRow[] = [];
  let round = 0;

  while (selected.length < count) {
    let addedThisRound = 0;

    for (const bucket of buckets) {
      if (selected.length >= count) break;
      if (round < bucket.length) {
        selected.push(bucket[round]);
        addedThisRound += 1;
      }
    }

    if (addedThisRound === 0) break; // All buckets exhausted.
    round += 1;
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

interface EvalEntry {
  index: number;
  lead: EligibleLeadRow;
  language: string;
  subject: string;
  body: string;
  error: string | null;
}

function renderMarkdown(entries: EvalEntry[], runId: string, totalMs: number): string {
  const now = new Date().toISOString();
  const passed = entries.filter((e) => !e.error).length;

  const lines: string[] = [
    `# AVI-17 Email Evaluation — Run ${runId}`,
    '',
    `Generated: ${now}`,
    `Source: leads table, ${EVAL_SIZE} enriched eligible rows`,
    `Total emails generated: ${entries.length}`,
    `Errors: ${entries.filter((e) => !!e.error).length}`,
    `Total time: ${(totalMs / 1000).toFixed(1)}s`,
    '',
    '## Reviewer checklist',
    '',
    'For each email, mark **PASS** or **FAIL**. Pass criteria:',
    "- Correct language for the lead's country (DE/AT/CH → German, else English)",
    '- Atelierra brand voice (fashion-level merch, not "branded merchandise")',
    '- "Produced in Europe" mentioned once',
    '- First name only in greeting',
    '- No AI filler / stacked adjectives',
    '- Body 60–110 words',
    '- If company hook present: at least one fact from it woven in naturally',
    '- Localized CTA (no mixed languages)',
    '',
    `**Gate: ≥16/${EVAL_SIZE} must PASS to proceed to AVI-18**`,
    '',
    `Reviewer pass count: __/${passed} checked so far`,
    '',
    '---',
    '',
  ];

  // Group by industry for structured reading.
  const byIndustry = new Map<string, EvalEntry[]>();
  for (const entry of entries) {
    const key = entry.lead.industry ?? 'unknown';
    if (!byIndustry.has(key)) byIndustry.set(key, []);
    byIndustry.get(key)!.push(entry);
  }

  for (const [industry, industryEntries] of byIndustry) {
    lines.push(`## Industry: ${industry}`);
    lines.push('');

    for (const entry of industryEntries) {
      const { index, lead, language, subject, body, error } = entry;

      lines.push(`### ${index}. ${lead.name} — ${lead.company}`);
      lines.push('');
      lines.push(`**Lead:** ${lead.title ?? 'Unknown title'} | ${lead.company}`);
      lines.push(`**Country:** ${lead.country} (Language: ${language})`);
      lines.push(`**Company hook:** ${lead.company_hook}`);
      lines.push('');

      if (error) {
        lines.push(`**ERROR:** ${error}`);
      } else {
        lines.push(`**Subject:** ${subject}`);
        lines.push('');
        lines.push('**Body:**');
        lines.push('');
        lines.push('```');
        lines.push(body);
        lines.push('```');
        lines.push('');
        lines.push('**[ ] PASS &nbsp;&nbsp; [ ] FAIL**');
        lines.push('');
        lines.push('**Reviewer notes:**');
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('AVI-17 email eval — reading enriched leads from Supabase…');
  const startMs = Date.now();

  // 1. Load candidates from DB.
  const candidates = await fetchEligibleLeads();
  console.log(`  Found ${candidates.length} eligible candidates (pool=${CANDIDATE_POOL})`);

  if (candidates.length < EVAL_SIZE) {
    console.error(
      `\nError: only ${candidates.length} eligible enriched leads found (need ${EVAL_SIZE}).`,
    );
    console.error('Run the safe Apollo-only poller first:');
    console.error('  npm run apollo:poll');
    console.error('Do NOT use npm run pipeline:once — it also creates Gmail drafts.');
    process.exit(1);
  }

  // 2. Select a diverse subset.
  const selected = selectDiverse(candidates, EVAL_SIZE);
  console.log(`  Selected ${selected.length} diverse leads across industries`);

  // 3. Hardcoded Atelierra eval template (voice reference only — not the live DB template).
  const evalTemplate = {
    body: 'Hi {{name}}, we produce fashion-level merch for brands that care about their appearance. We would love to put together a capsule collection for {{company}}. Produced in Europe.',
  };

  // 4. Generate emails.
  const entries: EvalEntry[] = [];

  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    const language = detectLanguageFromCountry(row.country);
    const lead: LeadContext = {
      name: row.name,
      title: row.title,
      company: row.company,
      linkedinUrl: row.linkedin_url,
      sourceCriteria: row.source_criteria,
      country: row.country,
      language,
      companyHook: row.company_hook,
    };

    console.log(`  [${i + 1}/${EVAL_SIZE}] ${row.name} @ ${row.company} (${language})`);

    try {
      const { subject, body } = await generateEmail(lead, evalTemplate);
      entries.push({ index: i + 1, lead: row, language, subject, body, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entries.push({ index: i + 1, lead: row, language, subject: '', body: '', error: message });
      console.error(`    ERROR: ${message}`);
    }
  }

  // 5. Write markdown report.
  const ts = new Date()
    .toISOString()
    .replace(/T/, '-')
    .replace(/:\d+\.\d+Z$/, '')
    .replace(/:/g, '');
  const runId = ts;
  const totalMs = Date.now() - startMs;
  const md = renderMarkdown(entries, runId, totalMs);

  const outPath = join(process.cwd(), 'docs', `eval-results-${ts}.md`);
  writeFileSync(outPath, md, 'utf8');

  console.log('');
  console.log(`Done — ${entries.filter((e) => !e.error).length}/${EVAL_SIZE} emails generated`);
  console.log(`Report: ${outPath}`);
  console.log(`Time: ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch((err: unknown) => {
  console.error('evaluateEmails failed:', err);
  process.exit(1);
});
