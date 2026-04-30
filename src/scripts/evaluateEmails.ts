// AVI-17: Eval gate script — generate 20 sample emails and write a reviewer-ready
// markdown doc under docs/. This script makes 20 live Gemini API calls.
//
// Usage: npm run eval:emails
//
// Requirements: GEMINI_API_KEY must be set in .env.
// Do NOT invoke from CI or `npm test` — this consumes real API quota.
//
// This script intentionally bypasses the active Supabase template and uses a
// hardcoded ATELIERRA_TEMPLATE_BODY fixture derived from the client's first
// emails. It does NOT update the production template; AVI-18 owns that decision.

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { generateEmail } from '../integrations/geminiClient';
import type { LeadContext } from '../integrations/geminiClient';
import { detectLanguageFromCountry } from '../lib/language';
import type { Language } from '../lib/language';

// ---------------------------------------------------------------------------
// Template fixture — Atelierra voice (eval-only, NOT pushed to Supabase)
// Sourced from the client's first-email examples (PDF, AVI-17 client review).
// ---------------------------------------------------------------------------

const TEMPLATE_NAME = 'Atelierra Eval Outreach (fixture only)';

const ATELIERRA_TEMPLATE_BODY = [
  "Hi {{name}},",
  '',
  "we're Atelierra and we produce fashion-level merch for companies that care about their appearance.",
  '',
  'For {{company}}, we would love to put together a collection for your team and community. We want to create fashion pieces that your team and community actually want to wear. Produced in Europe.',
  '',
  'I would love to walk you through a few ideas and hear what matters most to you.',
  '',
  'Are you the right person to talk to about this, or could you point me to someone on your brand or marketing team?',
  '',
  'Kind regards from Berlin,',
].join('\n');

// ---------------------------------------------------------------------------
// Persona cohorts
// 5 groups × 4 distinct leads = 20 emails total.
// `country` drives language detection (DACH → de, else en) so the eval reflects
// what the rep would actually send.
// ---------------------------------------------------------------------------

interface EvalLead extends Omit<LeadContext, 'language'> {
  displayLabel: string;
}

interface PersonaGroup {
  id: string;
  description: string;
  leads: EvalLead[];
}

// Leads sourced from docs/normale_Leads.md — real prospect context from the pipeline.
// Note: email addresses from that file are intentionally omitted (no email field in LeadContext).
const PERSONAS: PersonaGroup[] = [
  {
    id: 'corporate-brand',
    description: 'Corporate — Brand & Marketing leaders at established European companies',
    leads: [
      {
        displayLabel: 'Sixt — Head of Brand Experience',
        name: 'Tobias Freundlieb',
        title: 'Head of Brand Experience',
        company: 'Sixt',
        linkedinUrl: null,
        sourceCriteria: 'Brand experience leader at major mobility/car rental company in DACH',
        country: 'DE',
      },
      {
        displayLabel: 'Audi — Brand Strategy & Brand Management',
        name: 'Tina Pulzer',
        title: 'Brand Strategy & Brand Management',
        company: 'Audi',
        linkedinUrl: null,
        sourceCriteria: 'Brand manager at premium automotive OEM in Germany',
        country: 'DE',
      },
      {
        displayLabel: 'Beiersdorf — NIVEA Global VP Marketing',
        name: 'Geraldine Weilandt',
        title: 'NIVEA Global VP Marketing',
        company: 'Beiersdorf (NIVEA)',
        linkedinUrl: null,
        sourceCriteria:
          'Global VP Marketing at consumer goods / personal care company in Hamburg',
        country: 'DE',
      },
      {
        displayLabel: 'Targo Bank — Head of Brand Management',
        name: 'Katharina Rubbert',
        title: 'Head of Brand Management',
        company: 'Targo Bank',
        linkedinUrl: null,
        sourceCriteria: 'Head of Brand Management at retail bank in Germany',
        country: 'DE',
      },
    ],
  },
  {
    id: 'fintech-tech-scaleup',
    description: 'Fintech & Tech Scale-ups — Brand, Marketing and Employer Brand roles',
    leads: [
      {
        displayLabel: 'Bitpanda — Creative and Brand Director',
        name: 'Sudarshan Waghmare',
        title: 'Creative and Brand Director',
        company: 'Bitpanda',
        linkedinUrl: null,
        sourceCriteria: 'Creative/Brand Director at crypto investment platform in Vienna',
        country: 'AT',
      },
      {
        displayLabel: 'Trade Republic — Brand Collaborations',
        name: 'Lia Darozhkina',
        title: 'Brand Collaborations',
        company: 'Trade Republic',
        linkedinUrl: null,
        sourceCriteria: 'Brand collaborations role at neo-broker fintech in Berlin',
        country: 'DE',
      },
      {
        displayLabel: 'monday.com — Head of Marketing',
        name: 'Shelly Shimoni',
        title: 'Head of Marketing',
        company: 'monday.com',
        linkedinUrl: null,
        sourceCriteria: 'Head of Marketing at B2B work OS platform in Tel Aviv',
        country: 'IL',
      },
      {
        displayLabel: 'Wizz Air — Recruitment Marketing & Branding Manager',
        name: 'Sofia Santos Tinoco',
        title: 'Recruitment Marketing & Branding Manager',
        company: 'Wizz Air',
        linkedinUrl: null,
        sourceCriteria:
          'Recruitment Marketing & Branding Manager at low-cost airline in Budapest',
        country: 'HU',
      },
    ],
  },
  {
    id: 'defense-aerospace',
    description: 'Defense & Aerospace — Marketing, Brand and Events roles',
    leads: [
      {
        displayLabel: 'Rheinmetall — Marketing Manager & Creative Head',
        name: 'Christian Rumpel',
        title: 'Marketing Manager | Creative Head',
        company: 'Rheinmetall',
        linkedinUrl: null,
        sourceCriteria: 'Marketing/Creative lead at major defense contractor in Düsseldorf',
        country: 'DE',
      },
      {
        displayLabel: 'Anduril — Brand Partnerships',
        name: 'Patrick Bark',
        title: 'Brand Partnerships',
        company: 'Anduril',
        linkedinUrl: null,
        sourceCriteria: 'Brand partnerships lead at defense tech startup in Los Angeles',
        country: 'US',
      },
      {
        displayLabel: 'Elbit Systems — People Communications & Employer Brand',
        name: 'Noa Kadisheviz',
        title: 'People Communications & Employer Brand Leader',
        company: 'Elbit Systems',
        linkedinUrl: null,
        sourceCriteria: 'Employer brand leader at defense electronics company in Tel Aviv',
        country: 'IL',
      },
      {
        displayLabel: 'Farnborough Airshow — Events Marketing Manager',
        name: 'Kathryn Turtlebrook',
        title: 'Events Marketing Manager',
        company: 'Farnborough International Airshow',
        linkedinUrl: null,
        sourceCriteria: 'Events marketing manager at major international airshow in the UK',
        country: 'GB',
      },
    ],
  },
  {
    id: 'events-messe-museum',
    description: 'Events, Messe & Museums — Marketing and communications roles',
    leads: [
      {
        displayLabel: 'Messe Frankfurt — Marketingkommunikation & Werbung',
        name: 'Valeria Moscagiuli',
        title: 'Marketingkommunikation & Werbung',
        company: 'Messe Frankfurt',
        linkedinUrl: null,
        sourceCriteria:
          'Marketing communications role at major international trade fair organizer',
        country: 'DE',
      },
      {
        displayLabel: 'RAI Amsterdam — Marketing Manager & Brand Strategy',
        name: 'Merle Eggink',
        title: 'Marketing Manager | Brand Strategy',
        company: 'RAI Amsterdam',
        linkedinUrl: null,
        sourceCriteria: 'Marketing/brand manager at major European convention and event center',
        country: 'NL',
      },
      {
        displayLabel: 'Rijksmuseum — Marketing',
        name: 'Barbara Lameris',
        title: 'Marketing',
        company: 'Rijksmuseum',
        linkedinUrl: null,
        sourceCriteria: 'Marketing role at world-class national art museum in Amsterdam',
        country: 'NL',
      },
      {
        displayLabel: 'Arthur D. Little — Director of Marketing and Communication',
        name: 'Hala Akiki',
        title: 'Director of Marketing and Communication',
        company: 'Arthur D. Little',
        linkedinUrl: null,
        sourceCriteria: 'Marketing director at global management consulting firm',
        country: 'BE',
      },
    ],
  },
  {
    id: 'ai-startup-employer-brand',
    description: 'AI, Startups & Employer Brand — Field marketing and brand roles',
    leads: [
      {
        displayLabel: 'Mistral AI — Field Marketing',
        name: 'Maud David',
        title: 'Field Marketing',
        company: 'Mistral AI',
        linkedinUrl: null,
        sourceCriteria: 'Field marketing at leading European AI startup in Paris',
        country: 'FR',
      },
      {
        displayLabel: 'Tailor Brands — Corporate Brand Strategist',
        name: 'Nadav Pessach',
        title: 'Corporate Brand Strategist',
        company: 'Tailor Brands',
        linkedinUrl: null,
        sourceCriteria: 'Corporate brand strategist at AI branding platform startup in Tel Aviv',
        country: 'IL',
      },
      {
        displayLabel: 'Babbel — Employer Branding',
        name: 'Hex Duarte',
        title: 'Employer Branding',
        company: 'Babbel',
        linkedinUrl: null,
        sourceCriteria: 'Employer branding role at language-learning tech company in Berlin',
        country: 'DE',
      },
      {
        displayLabel: 'Cellebrite — B2B Field Marketing & Events',
        name: 'Evgeniia Bubnova',
        title: 'B2B Field Marketing | Events',
        company: 'Cellebrite',
        linkedinUrl: null,
        sourceCriteria:
          'B2B field marketing and events lead at digital intelligence company in Munich',
        country: 'DE',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface EvalResultOk {
  status: 'ok';
  subject: string;
  body: string;
}

interface EvalResultError {
  status: 'error';
  message: string;
}

type EvalResult = EvalResultOk | EvalResultError;

interface EvalEntry {
  lead: EvalLead;
  language: Language;
  group: PersonaGroup;
  index: number; // 1-based, across all 20
  result: EvalResult;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function utcTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function filenameTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const YYYY = now.getUTCFullYear();
  const MM = pad(now.getUTCMonth() + 1);
  const DD = pad(now.getUTCDate());
  const HH = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  return `${YYYY}-${MM}-${DD}-${HH}${mm}`;
}

function renderMarkdown(entries: EvalEntry[], runAt: string): string {
  const lines: string[] = [];

  lines.push('# AVI-17 Eval Results — 20 Sample Emails (Atelierra voice)');
  lines.push('');
  lines.push('## Run Metadata');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Generated at | ${runAt} |`);
  lines.push(`| Model | \`gemini-2.5-flash\` |`);
  lines.push(`| Template fixture | ${TEMPLATE_NAME} (eval-only, not in DB) |`);
  lines.push(`| Total emails | 20 (5 persona groups × 4 leads each) |`);
  lines.push(
    `| Language detection | DACH (DE/AT/CH) → German; everything else → English |`,
  );
  lines.push('');

  lines.push('## Reviewer Instructions');
  lines.push('');
  lines.push(
    'For each email below, fill in the **Rating** column with one of: `pass` / `needs edit` / `fail`.',
  );
  lines.push('Use the **Notes** column for short feedback if the rating is not `pass`.');
  lines.push('');
  lines.push('**Gate:** If **≥ 16 out of 20** (80%) are rated `pass`, proceed to AVI-18.');
  lines.push(
    'If < 16 pass, refine the prompt in `src/integrations/geminiClient.ts` and re-run `npm run eval:emails`.',
  );
  lines.push('');

  for (const group of PERSONAS) {
    lines.push(`---`);
    lines.push('');
    lines.push(`## Group: ${group.description}`);
    lines.push('');

    const groupEntries = entries.filter((e) => e.group.id === group.id);

    for (const entry of groupEntries) {
      const { lead, language, index, result } = entry;

      lines.push(`### ${index}. ${lead.displayLabel}`);
      lines.push('');
      lines.push('**Lead context:**');
      lines.push('');
      lines.push(`- Name: ${lead.name ?? '—'}`);
      lines.push(`- Title: ${lead.title ?? '—'}`);
      lines.push(`- Company: ${lead.company ?? '—'}`);
      lines.push(`- Country: ${lead.country ?? '—'} (Language: \`${language}\`)`);
      lines.push(`- LinkedIn: ${lead.linkedinUrl ?? '—'}`);
      lines.push(`- Source criteria: ${lead.sourceCriteria ?? '—'}`);
      lines.push('');

      if (result.status === 'ok') {
        lines.push(`**Subject:** ${result.subject}`);
        lines.push('');
        lines.push('**Body:**');
        lines.push('');
        lines.push('```');
        lines.push(result.body);
        lines.push('```');
      } else {
        lines.push(`**ERROR:** ${result.message}`);
      }

      lines.push('');
      lines.push('**Review:**');
      lines.push('');
      lines.push('| Rating | Notes |');
      lines.push('|--------|-------|');
      lines.push('|        |       |');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('Fill this in after completing all ratings above.');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push('| Total emails | 20 |');
  lines.push('| pass |  |');
  lines.push('| needs edit |  |');
  lines.push('| fail |  |');
  lines.push('| ERROR (generation failed) |  |');
  lines.push('');
  lines.push('**Gate result:** [ ] Pass (≥ 16 pass) &nbsp;&nbsp; [ ] Fail (< 16 pass)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '_This document was generated by `npm run eval:emails` and must be committed with ratings filled in before AVI-18 begins._',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nAVI-17 — Email Eval Gate (Atelierra voice)');
  console.log('─'.repeat(50));
  console.warn(
    'WARNING: This script makes 20 live Gemini API calls and consumes real API quota.',
  );
  console.log('─'.repeat(50));
  console.log('');

  const runAt = utcTimestamp();
  const entries: EvalEntry[] = [];
  let emailIndex = 1;
  let errorCount = 0;

  for (const group of PERSONAS) {
    console.log(`Group: ${group.description}`);

    for (const lead of group.leads) {
      const language = detectLanguageFromCountry(lead.country);

      process.stdout.write(
        `  [${emailIndex}/20] ${lead.displayLabel} (${lead.country ?? '—'} → ${language}) … `,
      );

      let result: EvalResult;

      try {
        const generated = await generateEmail(
          { ...lead, language },
          { body: ATELIERRA_TEMPLATE_BODY },
        );
        result = { status: 'ok', subject: generated.subject, body: generated.body };
        console.log('ok');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = { status: 'error', message };
        errorCount++;
        console.log(`ERROR: ${message}`);
      }

      entries.push({ lead, language, group, index: emailIndex, result });
      emailIndex++;
    }

    console.log('');
  }

  const markdown = renderMarkdown(entries, runAt);
  const filename = `eval-results-${filenameTimestamp()}.md`;
  const outPath = join(process.cwd(), 'docs', filename);

  writeFileSync(outPath, markdown, 'utf8');

  const generated = 20 - errorCount;

  console.log('─'.repeat(50));
  console.log(`Generated: ${generated}/20`);
  if (errorCount > 0) {
    console.log(`Errors:    ${errorCount} (see ERROR cells in the doc)`);
  }
  console.log(`Output:    docs/${filename}`);
  console.log('─'.repeat(50));
  console.log('');
  console.log('Next step: open the doc, rate each email (pass / needs edit / fail),');
  console.log('commit the completed doc on this branch, then open the PR.');
  console.log('');

  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Fatal eval error:', err);
  process.exit(1);
});
