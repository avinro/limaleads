// Main worker entrypoint — orchestrates all scheduled jobs and starts the
// admin HTTP server (GET /health + POST /admin/leads/:id/status).
// New jobs are registered here as the system grows.

import { notifyLeadReply } from './integrations/telegramNotifier';
import { recordJobRun } from './lib/jobState';
import { createApp } from './server';
import { runApolloPoller } from './jobs/apolloPoller';
import { runDraftJob } from './jobs/draftJob';
import { runFollowUpScheduler } from './jobs/followUpScheduler';
import { runReplyDetection } from './jobs/replyDetectionJob';
import { runSentDetection } from './jobs/sentDetectionJob';
import { logJob } from './lib/logger';

const DEFAULT_INTERVAL_HOURS = 4;
const DEFAULT_SENT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_REPLY_POLL_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_FOLLOW_UP_RUN_AT_UTC = '09:00';

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
// Follow-up fixed-time scheduler helpers
// ---------------------------------------------------------------------------

/**
 * Parses FOLLOW_UP_RUN_AT_UTC as "HH:mm". Returns { hours, minutes }.
 * Falls back to DEFAULT_FOLLOW_UP_RUN_AT_UTC on any parse error.
 */
function getFollowUpRunAt(): { hours: number; minutes: number } {
  const raw = process.env.FOLLOW_UP_RUN_AT_UTC ?? DEFAULT_FOLLOW_UP_RUN_AT_UTC;
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);

  if (!match) {
    console.warn(
      `Invalid FOLLOW_UP_RUN_AT_UTC "${raw}"; expected HH:mm, using default ${DEFAULT_FOLLOW_UP_RUN_AT_UTC}`,
    );
    return { hours: 9, minutes: 0 };
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    console.warn(
      `Out-of-range FOLLOW_UP_RUN_AT_UTC "${raw}"; using default ${DEFAULT_FOLLOW_UP_RUN_AT_UTC}`,
    );
    return { hours: 9, minutes: 0 };
  }

  return { hours, minutes };
}

/**
 * Returns the milliseconds until the next UTC occurrence of HH:mm.
 * If that time already passed today, schedules for tomorrow.
 * Minimum delay: 1 minute (avoids re-running immediately after a run that
 * completes just before the target tick).
 */
function msUntilNextUtc(hours: number, minutes: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0, 0),
  );

  const ONE_MINUTE_MS = 60_000;
  if (next.getTime() - now.getTime() < ONE_MINUTE_MS) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - Date.now();
}

// ---------------------------------------------------------------------------
// Reply detection loop (runs every GMAIL_REPLY_POLL_INTERVAL_MS, default 5 min)
// ---------------------------------------------------------------------------

// Guard against overlapping reply-detection runs (e.g. during Gmail outages).
let isReplyDetectionRunning = false;

/**
 * Runs one reply-detection pass. If the previous pass is still in flight,
 * logs the skip and returns.
 */
async function runReplyDetectionTick(): Promise<void> {
  if (isReplyDetectionRunning) {
    await logJob('reply-detection', 'started', { skipped: true, reason: 'overlap' });
    return;
  }

  isReplyDetectionRunning = true;

  try {
    const summary = await runReplyDetection((lead, reply) => notifyLeadReply({ lead, reply }));
    console.log('Reply detection finished:', summary);
    recordJobRun('replyDetection');
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

    recordJobRun('apolloCycle');
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
    recordJobRun('sentDetection');
  } catch (error) {
    console.error('Sent detection failed:', error);
  } finally {
    isSentDetectionRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Follow-up scheduler (runs daily at FOLLOW_UP_RUN_AT_UTC, default 09:00 UTC)
// ---------------------------------------------------------------------------

// Guard against overlapping follow-up runs (e.g. if the scheduler takes longer
// than expected on a large batch).
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
    recordJobRun('followUpScheduler');
  } catch (error) {
    console.error('Follow-up scheduler failed:', error);
  } finally {
    isFollowUpRunning = false;
  }
}

/**
 * Schedules follow-up to run daily at the configured UTC time.
 * Uses chained setTimeout so each run schedules the next, keeping the
 * clock anchored to the configured time regardless of how long each run takes.
 */
function scheduleFollowUp(hours: number, minutes: number): void {
  const delayMs = msUntilNextUtc(hours, minutes);
  const nextRun = new Date(Date.now() + delayMs).toISOString();
  console.log(`Follow-up scheduler next run at ${nextRun} UTC`);

  setTimeout(() => {
    void runFollowUpTick().then(() => {
      scheduleFollowUp(hours, minutes);
    });
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('LimaLeads worker started');

  const PORT = Number(process.env.PORT ?? 3000);
  createApp().listen(PORT, () => {
    console.log(`Admin server listening on :${PORT}`);
  });

  // Run all polling jobs immediately on startup, then on their respective intervals.
  await runCycle();
  await runSentDetectionTick();
  await runReplyDetectionTick();

  // Follow-up scheduler: run once immediately, then schedule daily at fixed UTC time.
  await runFollowUpTick();
  const { hours, minutes } = getFollowUpRunAt();
  console.log(
    `Follow-up scheduler configured for ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} UTC daily`,
  );
  scheduleFollowUp(hours, minutes);

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
