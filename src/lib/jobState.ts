// Module-level singleton shared between src/index.ts (writes) and src/server.ts
// (reads via GET /health). Node.js module cache guarantees a single instance.

export type WorkerJobName =
  | 'apolloCycle'
  | 'sentDetection'
  | 'followUpScheduler'
  | 'replyDetection';

const state: Record<WorkerJobName, string | null> = {
  apolloCycle: null,
  sentDetection: null,
  followUpScheduler: null,
  replyDetection: null,
};

export function recordJobRun(job: WorkerJobName): void {
  state[job] = new Date().toISOString();
}

export function getLastJobRun(): Record<WorkerJobName, string | null> {
  return { ...state };
}
