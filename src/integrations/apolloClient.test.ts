import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApolloEnrichedPerson,
  type ApolloSearchPerson,
  enrichPerson,
  searchPeople,
} from './apolloClient';

const MOCK_API_KEY = 'test-api-key';

const MOCK_SEARCH_PERSON: ApolloSearchPerson = {
  id: 'apollo-id-1',
  first_name: 'Jane',
  last_name_obfuscated: 'Do***',
  title: 'CEO',
  has_email: true,
  organization: { name: 'Acme Corp' },
};

const MOCK_ENRICHED_PERSON: ApolloEnrichedPerson = {
  id: 'apollo-id-1',
  name: 'Jane Doe',
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@acme.com',
  title: 'CEO',
  linkedin_url: 'https://linkedin.com/in/janedoe',
  organization: { name: 'Acme Corp' },
};

describe('apolloClient', () => {
  beforeEach(() => {
    process.env.APOLLO_API_KEY = MOCK_API_KEY;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APOLLO_API_KEY;
  });

  // ---------------------------------------------------------------------------
  // searchPeople
  // ---------------------------------------------------------------------------

  describe('searchPeople', () => {
    it('sends POST to mixed_people/api_search with correct headers and body', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            people: [MOCK_SEARCH_PERSON],
            pagination: { page: 1, per_page: 100, total_entries: 1, total_pages: 1 },
          }),
          { status: 200 },
        ),
      );

      const criteria = { person_titles: ['CEO'] };
      const result = await searchPeople(criteria, 1, 100);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.apollo.io/api/v1/mixed_people/api_search');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(MOCK_API_KEY);
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.person_titles).toEqual(['CEO']);
      expect(body.page).toBe(1);
      expect(body.per_page).toBe(100);

      expect(result.people).toHaveLength(1);
      expect(result.people[0].id).toBe('apollo-id-1');
      expect(result.pagination.total_pages).toBe(1);
    });

    it('returns empty people array when API returns no people field', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const result = await searchPeople({});
      expect(result.people).toEqual([]);
    });

    it('throws on non-2xx response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' }),
      );

      await expect(searchPeople({})).rejects.toThrow('Apollo search failed: 429');
    });

    it('throws when APOLLO_API_KEY is missing', async () => {
      delete process.env.APOLLO_API_KEY;
      await expect(searchPeople({})).rejects.toThrow('APOLLO_API_KEY');
    });
  });

  // ---------------------------------------------------------------------------
  // enrichPerson
  // ---------------------------------------------------------------------------

  describe('enrichPerson', () => {
    it('sends POST to people/match with the apollo id in query string', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ person: MOCK_ENRICHED_PERSON }), { status: 200 }),
      );

      const result = await enrichPerson('apollo-id-1');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.apollo.io/api/v1/people/match?id=apollo-id-1');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(MOCK_API_KEY);

      expect(result).not.toBeNull();
      expect(result!.email).toBe('jane@acme.com');
    });

    it('returns null when API response has no person field', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const result = await enrichPerson('apollo-id-1');
      expect(result).toBeNull();
    });

    it('returns the person even when email is null', async () => {
      const noEmail = { ...MOCK_ENRICHED_PERSON, email: null };
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ person: noEmail }), { status: 200 }),
      );

      const result = await enrichPerson('apollo-id-1');
      expect(result).not.toBeNull();
      expect(result!.email).toBeNull();
    });

    it('throws on non-2xx response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
      );

      await expect(enrichPerson('apollo-id-1')).rejects.toThrow('Apollo enrich failed: 401');
    });

    it('URL-encodes the apollo id in the query string', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ person: MOCK_ENRICHED_PERSON }), { status: 200 }),
      );

      await enrichPerson('id with spaces');
      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toContain('id=id%20with%20spaces');
    });
  });
});
