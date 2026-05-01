// Manual one-shot trigger for the AVI-19 sent-detection job.
//
// Runs one poll pass and prints the summary as JSON, then exits.
// Use this to verify the 2-minute SLA manually:
//   1. Have a lead in status='draft_created'.
//   2. Send the Gmail draft as the rep.
//   3. Run: npm run sent:once
//   4. Check that the row shows status='contacted', contacted_at set,
//      and edited_before_send reflects whether the draft was modified.
//
// Usage:
//   npm run sent:once
//
// WARNING: Do not run while the worker (npm run dev) is active — both
// processes would call findSentMessageForLead for the same leads concurrently.

import 'dotenv/config';
import { runSentDetection } from '../jobs/sentDetectionJob';

async function main(): Promise<void> {
  console.log('Running sent detection once...');

  const summary = await runSentDetection();

  console.log('Sent detection summary:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Sent detection failed:', err);
  process.exit(1);
});
