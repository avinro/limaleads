// Manual one-shot pipeline trigger for the AVI-14 acceptance test and ops use.
//
// Runs one Apollo poll (capped at PIPELINE_ONCE_MAX_PAGES pages, default 1)
// followed by one draft job pass. Prints both summaries as JSON and exits.
//
// Usage:
//   npm run pipeline:once
//   PIPELINE_ONCE_MAX_PAGES=3 npm run pipeline:once
//
// WARNING: Do not run while the worker (npm run dev) is active — there is no
// cross-process lock and both processes would race on the same 'new' leads.

import 'dotenv/config';
import { runApolloPoller } from '../jobs/apolloPoller';
import { runDraftJob } from '../jobs/draftJob';

async function main(): Promise<void> {
  const maxPagesRaw = process.env.PIPELINE_ONCE_MAX_PAGES ?? '1';
  const maxPages = Number(maxPagesRaw);

  if (!Number.isFinite(maxPages) || maxPages < 1) {
    console.error(`Invalid PIPELINE_ONCE_MAX_PAGES: "${maxPagesRaw}". Must be a positive integer.`);
    process.exit(1);
  }

  console.log(`Running pipeline once (Apollo max pages: ${maxPages})`);

  const pollSummary = await runApolloPoller(maxPages);
  console.log('Apollo poller summary:', JSON.stringify(pollSummary, null, 2));

  const draftSummary = await runDraftJob();
  console.log('Draft job summary:', JSON.stringify(draftSummary, null, 2));
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
