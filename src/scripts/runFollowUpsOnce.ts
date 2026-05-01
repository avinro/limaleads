// Manual one-shot trigger for the AVI-20 follow-up scheduler.
//
// Runs one scheduling pass and prints the summary as JSON, then exits.
// Use this to manually verify that eligible leads receive follow-up drafts:
//   1. Have at least one lead in status='contacted' with contacted_at older
//      than template.follow_up_days days and a valid gmail_thread_id.
//   2. Run: npm run followups:once
//   3. Check Gmail for a follow-up draft in the original thread.
//   4. Check that the lead status is 'follow_up_scheduled' in Supabase.
//   5. Send the draft in Gmail, then run: npm run sent:once
//   6. Confirm status='follow_up_sent', follow_up_count incremented,
//      and last_follow_up_at set.
//
// Usage:
//   npm run followups:once
//
// WARNING: Do not run while the worker (npm run dev) is active — both
// processes would call createGmailDraft for the same leads concurrently.

import 'dotenv/config';
import { runFollowUpScheduler } from '../jobs/followUpScheduler';

async function main(): Promise<void> {
  console.log('Running follow-up scheduler once...');

  const summary = await runFollowUpScheduler();

  console.log('Follow-up scheduler summary:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Follow-up scheduler failed:', err);
  process.exit(1);
});
