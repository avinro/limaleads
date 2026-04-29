// Main worker entrypoint — orchestrates all scheduled jobs.
// New jobs are registered here as the system grows.

import { runApolloPoller } from './jobs/apolloPoller';

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

// Guard against overlapping runs if a poll cycle takes longer than the interval.
let isPollerRunning = false;

async function runPollerOnce(): Promise<void> {
  if (isPollerRunning) {
    console.warn('Apollo poller is still running from the previous cycle — skipping this tick');
    return;
  }

  isPollerRunning = true;

  try {
    const summary = await runApolloPoller();
    console.log('Apollo poller finished:', summary);
  } catch (error) {
    console.error('Apollo poller failed:', error);
  } finally {
    isPollerRunning = false;
  }
}

async function main(): Promise<void> {
  console.log('LimaLeads worker started');

  // Run immediately on startup, then on a fixed interval.
  await runPollerOnce();

  const intervalMs = getIntervalMs();
  console.log(`Apollo poller scheduled every ${intervalMs / 1000 / 60 / 60}h`);

  setInterval(() => {
    void runPollerOnce();
  }, intervalMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
