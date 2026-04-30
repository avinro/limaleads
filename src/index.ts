// Main worker entrypoint — orchestrates all scheduled jobs.
// New jobs are registered here as the system grows.

import { runApolloPoller } from './jobs/apolloPoller';
import { runDraftJob } from './jobs/draftJob';

const DEFAULT_INTERVAL_HOURS = 4;

function getIntervalMs(): number {
  const raw = process.env.APOLLO_POLL_INTERVAL_HOURS;
  const hours = raw ? Number(raw) : DEFAULT_INTERVAL_HOURS;

  if (!Number.isFinite(hours) || hours <= 0) {
    console.warn(
      `Invalid APOLLO_POLL_INTERVAL_HOURS "${raw}"; using default ${DEFAULT_INTERVAL_HOURS}h`,
    );
    return DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;
  }

  return hours * 60 * 60 * 1000;
}

// Guard against overlapping runs if a cycle takes longer than the interval.
let isCycleRunning = false;

/**
 * Runs one full pipeline cycle: Apollo ingestion followed by draft creation.
 * Each job runs unconditionally with its own try/catch so a failure in one
 * does not prevent the other from executing.
 */
async function runCycle(): Promise<void> {
  if (isCycleRunning) {
    console.warn('Cycle still running from previous tick — skipping');
    return;
  }

  isCycleRunning = true;

  try {
    try {
      const pollSummary = await runApolloPoller();
      console.log('Apollo poller finished:', pollSummary);
    } catch (error) {
      console.error('Apollo poller failed:', error);
    }

    try {
      const draftSummary = await runDraftJob();
      console.log('Draft job finished:', draftSummary);
    } catch (error) {
      console.error('Draft job failed:', error);
    }
  } finally {
    isCycleRunning = false;
  }
}

async function main(): Promise<void> {
  console.log('LimaLeads worker started');

  // Run immediately on startup, then on a fixed interval.
  await runCycle();

  const intervalMs = getIntervalMs();
  console.log(`Cycle scheduled every ${intervalMs / 1000 / 60 / 60}h`);

  setInterval(() => {
    void runCycle();
  }, intervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
