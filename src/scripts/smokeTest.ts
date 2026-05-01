// Live smoke tests — verify real API credentials and connectivity.
// Run with: npm run smoke:test
// Does NOT consume Apollo credits (search only).
// Gmail sends to the authenticated account itself (safe self-send).

import 'dotenv/config';
import { searchPeople, type ApolloSourceCriteria } from '../integrations/apolloClient';
import { getRepSenderEmail } from '../integrations/gmailAuth';
import { generateEmail } from '../integrations/geminiClient';
import { sendEmail } from '../integrations/gmailClient';
import { getSupabaseClient } from '../db/client';

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'SKIP';

interface TestResult {
  name: string;
  status: Status;
  detail: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function run(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail, durationMs: Date.now() - start });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', detail: message, durationMs: Date.now() - start });
  }
}

// ---------------------------------------------------------------------------
// Apollo
// ---------------------------------------------------------------------------

async function testApollo(): Promise<void> {
  await run('Apollo — searchPeople (free, no credits)', async () => {
    const criteria = JSON.parse(process.env.APOLLO_SOURCE_CRITERIA ?? '{}') as ApolloSourceCriteria;
    const page = await searchPeople(criteria, 1, 5);
    return `total_entries=${page.pagination.total_entries}, people_returned=${page.people.length}`;
  });
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function testGemini(): Promise<void> {
  await run('Gemini — generateEmail (initial outreach)', async () => {
    const email = await generateEmail(
      {
        name: 'Test Lead',
        title: 'CEO',
        company: 'Smoke Test Corp',
        linkedinUrl: null,
        sourceCriteria: null,
        country: 'GB',
        language: 'en',
        companyHook: null,
      },
      { body: 'Hi {{name}}, I wanted to reach out about {{company}}.' },
    );
    const subjectPreview = email.subject.slice(0, 60);
    const bodyWords = email.body.split(/\s+/).length;
    return `subject="${subjectPreview}" body_words=${bodyWords}`;
  });

  await run('Gemini — generateEmail (follow-up scenario)', async () => {
    const email = await generateEmail(
      {
        name: 'Test Lead',
        title: 'CTO',
        company: 'Smoke Test Corp',
        linkedinUrl: null,
        sourceCriteria: null,
        country: 'DE',
        language: 'de',
        companyHook: null,
      },
      { body: 'Following up on my previous note about {{company}}.' },
    );
    return `subject="${email.subject.slice(0, 60)}" body_words=${email.body.split(/\s+/).length}`;
  });
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

async function testGmail(): Promise<void> {
  await run('Gmail — getProfile (auth check)', async () => {
    const email = await getRepSenderEmail();
    return `authenticated as ${email}`;
  });

  await run('Gmail — sendEmail (self-send smoke test)', async () => {
    const to = await getRepSenderEmail();

    const sent = await sendEmail({
      to,
      subject: '[LimaLeads smoke test] Gmail API check',
      body: 'This is an automated smoke test sent by the LimaLeads smoke test script.\n\nIf you see this, the Gmail API is working correctly.\n\nYou can delete this email.',
    });

    return `messageId=${sent.messageId} threadId=${sent.threadId} delivered_to=${to}`;
  });
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

async function testSupabase(): Promise<void> {
  await run('Supabase — leads table (select count)', async () => {
    const db = getSupabaseClient();
    const { count, error } = await db.from('leads').select('*', { count: 'exact', head: true });

    if (error) throw new Error(error.message);

    return `leads_count=${count ?? 0}`;
  });

  await run('Supabase — lead_status_events table (select count)', async () => {
    const db = getSupabaseClient();
    const { count, error } = await db
      .from('lead_status_events')
      .select('*', { count: 'exact', head: true });

    if (error) throw new Error(error.message);

    return `events_count=${count ?? 0}`;
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n🔬 LimaLeads API Smoke Tests\n');
  console.log('Running live checks against: Apollo · Gemini · Gmail · Supabase\n');

  await testApollo();
  await testGemini();
  await testGmail();
  await testSupabase();

  // Print results table
  const maxName = Math.max(...results.map((r) => r.name.length));

  console.log('\n' + '─'.repeat(maxName + 30));
  console.log(`${'Test'.padEnd(maxName)}   Status   ms    Detail`);
  console.log('─'.repeat(maxName + 30));

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭️';
    const status = r.status.padEnd(6);
    const ms = String(r.durationMs).padStart(5) + 'ms';
    console.log(`${r.name.padEnd(maxName)}   ${icon} ${status}  ${ms}  ${r.detail}`);
  }

  console.log('─'.repeat(maxName + 30));

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log(`\nResult: ${passed} passed · ${failed} failed out of ${results.length} checks\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal smoke test error:', err);
  process.exit(1);
});
