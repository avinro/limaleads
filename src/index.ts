// Main worker entrypoint — orchestrates all scheduled jobs.
// New jobs are registered here as the system grows.

import { runApolloPoller } from './jobs/apolloPoller';
import { runDraftJob } from './jobs/draftJob';
import { runSentDetection } from './jobs/sentDetectionJob';
import { logJob } from './lib/logger';

const DEFAULT_INTERVAL_HOURS = 4;
const DEFAULT_SENT_POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Interval parsers
// ---------------------------------------------------------------------------

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

function getSentPollIntervalMs(): number {
  const raw = process.env.GMAIL_SENT_POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_SENT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid GMAIL_SENT_POLL_INTERVAL_MS "${raw}"; using default ${DEFAULT_SENT_POLL_INTERVAL_MS}ms`,
    );
    return DEFAULT_SENT_POLL_INTERVAL_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Apollo + draft cycle (runs every APOLLO_POLL_INTERVAL_HOURS)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sent detection loop (runs every GMAIL_SENT_POLL_INTERVAL_MS, default 60s)
// ---------------------------------------------------------------------------

// Guard against overlapping sent-detection runs (e.g. during Gmail outages).
let isSentDetectionRunning = false;

/**
 * Runs one sent-detection pass. If the previous pass is still in flight
 * (unlikely but possible during a Gmail outage), logs the skip and returns.
 */
async function runSentDetectionTick(): Promise<void> {
  if (isSentDetectionRunning) {
    await logJob('sent-detection', 'started', { skipped: true, reason: 'overlap' });
    return;
  }

  isSentDetectionRunning = true;

  try {
    const summary = await runSentDetection();
    console.log('Sent detection finished:', summary);
  } catch (error) {
    console.error('Sent detection failed:', error);
  } finally {
    isSentDetectionRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LimaLeads worker started');

  // Run both jobs immediately on startup, then on their respective intervals.
  await runCycle();
  await runSentDetectionTick();

  const intervalMs = getIntervalMs();
  console.log(`Apollo/draft cycle scheduled every ${intervalMs / 1000 / 60 / 60}h`);

  setInterval(() => {
    void runCycle();
  }, intervalMs);

  const sentPollMs = getSentPollIntervalMs();
  console.log(`Sent detection scheduled every ${sentPollMs / 1000}s`);

  setInterval(() => {
    void runSentDetectionTick();
  }, sentPollMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
