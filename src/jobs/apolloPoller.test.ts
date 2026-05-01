import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApolloPoller } from './apolloPoller';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../integrations/apolloClient', () => ({
  searchPeople: vi.fn(),
  enrichPerson: vi.fn(),
}));

vi.mock('../lib/retry', () => ({
  runWithRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../lib/logger', () => ({
  logJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/leadStatus', () => ({
  transitionLeadStatus: vi.fn().mockResolvedValue({ id: 'event-id' }),
}));

vi.mock('../db/client', () => ({
  getSupabaseClient: vi.fn(),
}));

import { enrichPerson, searchPeople } from '../integrations/apolloClient';
import { logJob } from '../lib/logger';
import { transitionLeadStatus } from '../lib/leadStatus';
import { getSupabaseClient } from '../db/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CRITERIA_JSON = JSON.stringify({ person_titles: ['CEO'] });

function makeSearchPage(people: object[] = [], totalPages = 1) {
  return {
    people,
    pagination: { page: 1, per_page: 100, total_entries: people.length, total_pages: totalPages },
  };
}

function makeSearchPerson(overrides: object = {}) {
  return {
    id: 'apollo-id-1',
    first_name: 'Jane',
    last_name_obfuscated: 'Do***',
    title: 'CEO',
    has_email: true,
    organization: { name: 'Acme Corp' },
    ...overrides,
  };
}

function makeEnrichedPerson(overrides: object = {}) {
  return {
    id: 'apollo-id-1',
    name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@acme.com',
    title: 'CEO',
    linkedin_url: 'https://linkedin.com/in/janedoe',
    headline: 'CEO at Acme Corp | Building the future',
    departments: ['executive'],
    seniority: 'c_suite',
    country: 'DE',
    organization: {
      name: 'Acme Corp',
      short_description: 'A leading provider of widgets.',
      industry: 'manufacturing',
      keywords: ['widgets', 'b2b', 'industrial'],
      technology_names: ['Salesforce'],
      hq_country: 'DE',
    },
    ...overrides,
  };
}

/** Build a chainable Supabase mock that returns the given insert result. */
function makeSupabaseMock(
  insertResult: { data: { id: string } | null; error: unknown },
  updateError: unknown = null,
) {
  const maybeSingle = vi.fn().mockResolvedValue(insertResult);
  const select = vi.fn().mockReturnValue({ maybeSingle });
  const insert = vi.fn().mockReturnValue({ select });
  // Update chain: .update(...).eq(...)
  const eq = vi.fn().mockResolvedValue({ error: updateError });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ insert, update });
  return { from, insert, select, maybeSingle, update, eq };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apolloPoller', () => {
  beforeEach(() => {
    process.env.APOLLO_SOURCE_CRITERIA = CRITERIA_JSON;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.APOLLO_SOURCE_CRITERIA;
  });

  it('inserts a new lead with enrichment fields and seeds the status audit event', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson());

    const db = makeSupabaseMock({ data: { id: 'lead-uuid-1' }, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(summary.fetched).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.duplicates).toBe(0);
    expect(summary.skipped).toBe(0);

    // Verify enrichment fields were included in the insert call.
    const insertArg = db.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(insertArg.company_hook).toBe('A leading provider of widgets.');
    expect(insertArg.industry).toBe('manufacturing');
    expect(insertArg.company_description).toBe('A leading provider of widgets.');
    expect(insertArg.headline).toBe('CEO at Acme Corp | Building the future');
    expect(insertArg.seniority).toBe('c_suite');
    expect(insertArg.country).toBe('DE');
    expect(typeof insertArg.apollo_enriched_at).toBe('string');

    expect(transitionLeadStatus).toHaveBeenCalledWith('lead-uuid-1', 'new', 'system');
    expect(logJob).toHaveBeenCalledWith(
      'apollo-poller',
      'success',
      expect.objectContaining({ created: 1 }),
    );
  });

  it('updates enrichment fields for duplicate leads without touching status', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson());

    // Insert returns null (ON CONFLICT DO NOTHING) → duplicate path.
    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(summary.duplicates).toBe(1);
    expect(summary.created).toBe(0);
    expect(transitionLeadStatus).not.toHaveBeenCalled();

    // Verify the update was called with enrichment fields.
    expect(db.update).toHaveBeenCalledTimes(1);
    const updateArg = db.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updateArg.company_hook).toBe('A leading provider of widgets.');
    expect(updateArg.country).toBe('DE');
    // Must NOT touch lifecycle fields.
    expect(updateArg.status).toBeUndefined();
    expect(updateArg.gmail_draft_id).toBeUndefined();
    expect(updateArg.contacted_at).toBeUndefined();

    // Update was matched by email.
    expect(db.eq).toHaveBeenCalledWith('email', 'jane@acme.com');
  });

  it('source_criteria stores the original JSON criteria, not hook data', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson());

    const db = makeSupabaseMock({ data: { id: 'lead-uuid-3' }, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    await runApolloPoller();

    const insertArg = db.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof insertArg.source_criteria).toBe('string');
    expect(insertArg.source_criteria).toBe(CRITERIA_JSON);
    // Hook data must not be merged into source_criteria.
    expect(insertArg.source_criteria).not.toContain('company_hook');
  });

  it('counts duplicate when INSERT returns null (ON CONFLICT DO NOTHING)', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson());

    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(summary.duplicates).toBe(1);
    expect(summary.created).toBe(0);
  });

  it('skips a lead when has_email is false (no enrich call)', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson({ has_email: false })]) as Awaited<
        ReturnType<typeof searchPeople>
      >,
    );

    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(enrichPerson).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('skips a lead when enrich returns null email', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson({ email: null }));

    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
  });

  it('skips a lead when company is null (required for personalization)', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([makeSearchPerson()]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson).mockResolvedValueOnce(makeEnrichedPerson({ organization: null }));

    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
  });

  it('continues processing remaining leads when enrichPerson throws', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([
        makeSearchPerson({ id: 'fail-id' }),
        makeSearchPerson({ id: 'ok-id' }),
      ]) as Awaited<ReturnType<typeof searchPeople>>,
    );
    vi.mocked(enrichPerson)
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce(makeEnrichedPerson());

    const db = makeSupabaseMock({ data: { id: 'lead-uuid-2' }, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    const summary = await runApolloPoller();

    // First enrich failed → skipped; second succeeded → created
    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.enriched).toBe(1);
  });

  it('logs started and success to job_log', async () => {
    vi.mocked(searchPeople).mockResolvedValueOnce(
      makeSearchPage([]) as Awaited<ReturnType<typeof searchPeople>>,
    );

    const db = makeSupabaseMock({ data: null, error: null });
    vi.mocked(getSupabaseClient).mockReturnValue(
      db as unknown as ReturnType<typeof getSupabaseClient>,
    );

    await runApolloPoller();

    expect(logJob).toHaveBeenCalledWith('apollo-poller', 'started', {});
    expect(logJob).toHaveBeenCalledWith('apollo-poller', 'success', expect.any(Object));
  });

  it('throws when APOLLO_SOURCE_CRITERIA is missing', async () => {
    delete process.env.APOLLO_SOURCE_CRITERIA;
    await expect(runApolloPoller()).rejects.toThrow('APOLLO_SOURCE_CRITERIA');
  });
});
