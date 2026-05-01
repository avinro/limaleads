// Main worker entrypoint — orchestrates all scheduled jobs.
// New jobs are registered here as the system grows.

import { runApolloPoller } from './jobs/apolloPoller';
import { runDraftJob } from './jobs/draftJob';
import { runFollowUpScheduler } from './jobs/followUpScheduler';
import { runReplyDetection } from './jobs/replyDetectionJob';
import { runSentDetection } from './jobs/sentDetectionJob';
import { logJob } from './lib/logger';

const DEFAULT_INTERVAL_HOURS = 4;
const DEFAULT_SENT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_FOLLOW_UP_INTERVAL_MS = 86_400_000; // 24 hours
const DEFAULT_REPLY_POLL_INTERVAL_MS = 300_000; // 5 minutes

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

function getFollowUpIntervalMs(): number {
  const raw = process.env.FOLLOW_UP_INTERVAL_MS;
  if (!raw) return DEFAULT_FOLLOW_UP_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid FOLLOW_UP_INTERVAL_MS "${raw}"; using default ${DEFAULT_FOLLOW_UP_INTERVAL_MS}ms`,
    );
    return DEFAULT_FOLLOW_UP_INTERVAL_MS;
  }
  return parsed;
}

function getReplyPollIntervalMs(): number {
  const raw = process.env.GMAIL_REPLY_POLL_INTERVAL_MS;
  if (!raw) return DEFAULT_REPLY_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid GMAIL_REPLY_POLL_INTERVAL_MS "${raw}"; using default ${DEFAULT_REPLY_POLL_INTERVAL_MS}ms`,
    );
    return DEFAULT_REPLY_POLL_INTERVAL_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reply detection loop (runs every GMAIL_REPLY_POLL_INTERVAL_MS, default 5 min)
// ---------------------------------------------------------------------------

// Guard against overlapping reply-detection runs (e.g. during Gmail outages).
let isReplyDetectionRunning = false;

/**
 * Runs one reply-detection pass. If the previous pass is still in flight,
 * logs the skip and returns.
 *
 * onReplyDetected is intentionally left as undefined (no-op) until AVI-22
 * wires in the Telegram notifier.
 */
async function runReplyDetectionTick(): Promise<void> {
  if (isReplyDetectionRunning) {
    await logJob('reply-detection', 'started', { skipped: true, reason: 'overlap' });
    return;
  }

  isReplyDetectionRunning = true;

  try {
    const summary = await runReplyDetection();
    console.log('Reply detection finished:', summary);
  } catch (error) {
    console.error('Reply detection failed:', error);
  } finally {
    isReplyDetectionRunning = false;
  }
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
// Follow-up scheduler (runs every FOLLOW_UP_INTERVAL_MS, default 24h)
// ---------------------------------------------------------------------------

// Guard against overlapping follow-up runs (e.g. if the scheduler takes longer
// than the interval on a large batch).
let isFollowUpRunning = false;

/**
 * Runs one follow-up scheduling pass. If the previous pass is still in flight,
 * logs the skip and returns.
 */
async function runFollowUpTick(): Promise<void> {
  if (isFollowUpRunning) {
    await logJob('follow-up-scheduler', 'started', { skipped: true, reason: 'overlap' });
    return;
  }

  isFollowUpRunning = true;

  try {
    const summary = await runFollowUpScheduler();
    console.log('Follow-up scheduler finished:', summary);
  } catch (error) {
    console.error('Follow-up scheduler failed:', error);
  } finally {
    isFollowUpRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LimaLeads worker started');

  // Run all jobs immediately on startup, then on their respective intervals.
  await runCycle();
  await runSentDetectionTick();
  await runFollowUpTick();
  await runReplyDetectionTick();

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

  const followUpMs = getFollowUpIntervalMs();
  console.log(`Follow-up scheduler scheduled every ${followUpMs / 1000 / 60 / 60}h`);

  setInterval(() => {
    void runFollowUpTick();
  }, followUpMs);

  const replyPollMs = getReplyPollIntervalMs();
  console.log(`Reply detection scheduled every ${replyPollMs / 1000 / 60}min`);

  setInterval(() => {
    void runReplyDetectionTick();
  }, replyPollMs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
