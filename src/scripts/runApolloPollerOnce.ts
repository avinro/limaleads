// Safe Apollo-only runner — polls and enriches leads WITHOUT creating Gmail drafts.
//
// Use this instead of `pipeline:once` when you want to populate enrichment data
// (company_hook, country, industry, etc.) without triggering the draft job.
//
// Usage:
//   npm run apollo:poll
//   APOLLO_POLL_MAX_PAGES=3 npm run apollo:poll
//
// WARNING: Apollo enrichment consumes one credit per contact with has_email:true.
//          Do not run while the worker (npm run dev) is active — no cross-process lock.

import 'dotenv/config';
import { runApolloPoller } from '../jobs/apolloPoller';

async function main(): Promise<void> {
  const maxPagesRaw = process.env.APOLLO_POLL_MAX_PAGES ?? '1';
  const maxPages = Number(maxPagesRaw);

  if (!Number.isFinite(maxPages) || maxPages < 1) {
    console.error(`Invalid APOLLO_POLL_MAX_PAGES: "${maxPagesRaw}". Must be a positive integer.`);
    process.exit(1);
  }

  console.log('\nApollo-only poller (safe — does NOT create Gmail drafts)');
  console.log('─'.repeat(55));
  console.warn(`WARNING: Enrichment consumes one Apollo credit per contact with has_email:true.`);
  console.log(`Max pages: ${maxPages}`);
  console.log('─'.repeat(55));
  console.log('');

  const summary = await runApolloPoller(maxPages);

  console.log('');
  console.log('Summary:', JSON.stringify(summary, null, 2));
  console.log('');
  console.log(
    'Next: verify Supabase has ≥20 leads with company_hook IS NOT NULL and country IS NOT NULL,',
  );
  console.log('then run: npm run eval:emails');
}

main().catch((err: unknown) => {
  console.error('Apollo poller failed:', err);
  process.exit(1);
});
