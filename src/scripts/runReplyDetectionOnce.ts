// Manual one-shot trigger for the AVI-21 reply detection job.
//
// Runs one poll pass and prints the summary as JSON, then exits.
// Use this to verify reply detection manually:
//   1. Have a lead in status='contacted' or 'follow_up_sent' with a gmail_thread_id.
//   2. Reply to the outreach email from the lead's email address.
//   3. Run: npm run replies:once
//   4. Check that the row shows status='replied', replied_at set.
//
// Usage:
//   npm run replies:once
//
// WARNING: Do not run while the worker (npm run dev) is active — both
// processes would call findReplyForLead for the same leads concurrently.

import 'dotenv/config';
import { runReplyDetection } from '../jobs/replyDetectionJob';

async function main(): Promise<void> {
  console.log('Running reply detection once...');

  const summary = await runReplyDetection();

  console.log('Reply detection summary:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Reply detection failed:', err);
  process.exit(1);
});
