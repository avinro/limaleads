// AVI-23: Tests for the admin HTTP server (GET /health and POST /admin/leads/:id/status).
// Supertest drives the Express app without binding a port.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('./db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

vi.mock('./lib/jobState', () => ({
  getLastJobRun: vi.fn(() => ({
    apolloCycle: null,
    sentDetection: null,
    followUpScheduler: null,
    replyDetection: null,
  })),
}));

vi.mock('./lib/leadStatus', () => ({
  VALID_LEAD_STATUSES: new Set([
    'new',
    'draft_created',
    'generation_failed',
    'contacted',
    'replied',
    'follow_up_scheduled',
    'follow_up_sent',
    'exhausted',
    'closed_won',
    'closed_lost',
    'disqualified',
  ]),
  transitionLeadStatus: vi.fn(),
}));

import { getSupabaseClient } from './db/client';
import { transitionLeadStatus } from './lib/leadStatus';
import { createApp } from './server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'test-secret-token';
const LEAD_ID = 'lead-uuid-1';

const EXISTING_LEAD = {
  id: LEAD_ID,
  email: 'john@acme.com',
  status: 'contacted',
};

const UPDATED_LEAD = {
  id: LEAD_ID,
  email: 'john@acme.com',
  name: 'John Doe',
  company: 'Acme Corp',
  status: 'closed_won',
  contacted_at: '2026-05-01T10:00:00.000Z',
  replied_at: null,
  updated_at: '2026-05-01T18:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds a Supabase mock that:
 *  - first call (lead existence check): resolves with `existingLead`
 *  - second call (re-fetch after transition): resolves with `updatedLead`
 */
function makeSupabaseMock(
  existingLead: typeof EXISTING_LEAD | null,
  updatedLead: typeof UPDATED_LEAD | null = UPDATED_LEAD,
): void {
  let callCount = 0;

  const single = vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(
        existingLead
          ? { data: existingLead, error: null }
          : { data: null, error: { message: 'not found' } },
      );
    }
    return Promise.resolve(
      updatedLead
        ? { data: updatedLead, error: null }
        : { data: null, error: { message: 'refetch failed' } },
    );
  });

  const eq = vi.fn().mockReturnValue({ single });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  vi.mocked(getSupabaseClient).mockReturnValue({ from } as never);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const originalEnv = process.env;

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...originalEnv, ADMIN_API_TOKEN: VALID_TOKEN };
});

afterEach(() => {
  process.env = originalEnv;
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with status ok and uptime', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof res.body.uptime).toBe('number');
  });

  it('includes per-job lastJobRun object with all jobs null on cold start', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.lastJobRun).toMatchObject({
      apolloCycle: null,
      sentDetection: null,
      followUpScheduler: null,
      replyDetection: null,
    });
  });

  it('does not require auth', async () => {
    const app = createApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:id/status — auth
// ---------------------------------------------------------------------------

describe('POST /admin/leads/:id/status — auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .send({ status: 'closed_won', reason: 'Manual close' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when token is wrong', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', 'Bearer wrong-token')
      .send({ status: 'closed_won', reason: 'Manual close' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 500 when ADMIN_API_TOKEN env var is not set', async () => {
    delete process.env.ADMIN_API_TOKEN;
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won', reason: 'Manual close' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'ADMIN_API_TOKEN is not configured' });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:id/status — validation
// ---------------------------------------------------------------------------

describe('POST /admin/leads/:id/status — validation', () => {
  it('returns 400 when status is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ reason: 'Manual close' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it('returns 400 when status is not a valid LeadStatus', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'flying', reason: 'Manual close' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status/i);
  });

  it('returns 400 when reason is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('returns 400 when reason is an empty string', async () => {
    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won', reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:id/status — 404
// ---------------------------------------------------------------------------

describe('POST /admin/leads/:id/status — 404', () => {
  it('returns 404 when lead does not exist', async () => {
    makeSupabaseMock(null);

    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/nonexistent-id/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won', reason: 'Wrong lead' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Lead not found' });
  });
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:id/status — transition errors
// ---------------------------------------------------------------------------

describe('POST /admin/leads/:id/status — transition errors', () => {
  it('returns 400 when transitionLeadStatus throws', async () => {
    makeSupabaseMock(EXISTING_LEAD);
    vi.mocked(transitionLeadStatus).mockRejectedValueOnce(
      new Error('transition_lead_status RPC failed: invalid transition'),
    );

    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won', reason: 'Manual close' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('invalid transition');
  });
});

// ---------------------------------------------------------------------------
// POST /admin/leads/:id/status — happy path
// ---------------------------------------------------------------------------

describe('POST /admin/leads/:id/status — happy path', () => {
  it('returns 200 with updated lead on valid transition', async () => {
    makeSupabaseMock(EXISTING_LEAD);
    vi.mocked(transitionLeadStatus).mockResolvedValueOnce({
      id: 'event-uuid',
      lead_id: LEAD_ID,
      from_status: 'contacted',
      to_status: 'closed_won',
      actor: 'manual',
      reason: 'Manual close',
      created_at: '2026-05-01T18:00:00.000Z',
    });

    const app = createApp();
    const res = await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'closed_won', reason: 'Manual close' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: LEAD_ID, status: 'closed_won' });
    expect(transitionLeadStatus).toHaveBeenCalledWith(
      LEAD_ID,
      'closed_won',
      'manual',
      'Manual close',
    );
  });

  it('calls transitionLeadStatus with actor=manual and provided reason', async () => {
    makeSupabaseMock(EXISTING_LEAD);
    vi.mocked(transitionLeadStatus).mockResolvedValueOnce({
      id: 'event-uuid-2',
      lead_id: LEAD_ID,
      from_status: 'new',
      to_status: 'disqualified',
      actor: 'manual',
      reason: 'No budget',
      created_at: '2026-05-01T18:00:00.000Z',
    });

    const app = createApp();
    await request(app)
      .post(`/admin/leads/${LEAD_ID}/status`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`)
      .send({ status: 'disqualified', reason: 'No budget' });

    expect(transitionLeadStatus).toHaveBeenCalledWith(
      LEAD_ID,
      'disqualified',
      'manual',
      'No budget',
    );
  });
});
