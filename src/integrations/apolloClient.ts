// Apollo API client — two-step Search → Enrich flow documented in docs/apollo-api-spike.md.
// Search is free; Enrich consumes credits. Only enrich people with has_email: true.

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

function getApiKey(): string {
  const key = process.env.APOLLO_API_KEY;

  if (!key) {
    throw new Error('Missing required environment variable: APOLLO_API_KEY');
  }

  return key;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApolloOrganization {
  name: string | null;
  // Rich context fields — populated by Enrich (/people/match) but also
  // partially available in Search results. All optional/nullable because
  // Apollo may omit or return null for any of them.
  short_description?: string | null;
  industry?: string | null;
  keywords?: string[] | null;
  technology_names?: string[] | null;
  founded_year?: number | null;
  latest_funding_stage?: string | null;
  // Location/country hints — field names vary by Apollo API version.
  country?: string | null;
  hq_country?: string | null;
  primary_domain?: string | null;
}

/** Shape of one result from POST /api/v1/mixed_people/api_search */
export interface ApolloSearchPerson {
  id: string;
  first_name: string | null;
  last_name_obfuscated: string | null;
  title: string | null;
  has_email: boolean;
  organization: ApolloOrganization | null;
}

/** Shape of the person object from POST /api/v1/people/match */
export interface ApolloEnrichedPerson {
  id: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  linkedin_url: string | null;
  organization: ApolloOrganization | null;
  // Rich person-level context — populated by Enrich only.
  headline?: string | null;
  departments?: string[] | null;
  seniority?: string | null;
  // Location/country hints.
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

/** Apollo filter parameters — matches the search endpoint body fields from the spike. */
export interface ApolloSourceCriteria {
  person_titles?: string[];
  include_similar_titles?: boolean;
  person_seniorities?: string[];
  person_locations?: string[];
  organization_locations?: string[];
  organization_num_employees_ranges?: string[];
  contact_email_status?: string[];
  q_organization_domains_list?: string[];
  q_keywords?: string;
  [key: string]: unknown;
}

export interface ApolloSearchPage {
  people: ApolloSearchPerson[];
  pagination: {
    page: number;
    per_page: number;
    total_entries: number;
    total_pages: number;
  };
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Search for people matching criteria. Does NOT consume credits.
 * Returns the full pagination block so callers can decide whether to fetch more pages.
 */
export async function searchPeople(
  criteria: ApolloSourceCriteria,
  page: number = 1,
  perPage: number = 100,
): Promise<ApolloSearchPage> {
  const apiKey = getApiKey();

  const response = await fetch(`${APOLLO_BASE_URL}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      ...criteria,
      page,
      per_page: perPage,
    }),
  });

  if (!response.ok) {
    throw new Error(`Apollo search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    people?: ApolloSearchPerson[];
    pagination?: ApolloSearchPage['pagination'];
  };

  return {
    people: data.people ?? [],
    pagination: data.pagination ?? {
      page,
      per_page: perPage,
      total_entries: 0,
      total_pages: 0,
    },
  };
}

/**
 * Enrich a person by Apollo ID. Consumes one credit per call.
 * Returns null if the API response contains no person or no email.
 * Callers should only invoke this for search results where has_email: true.
 */
export async function enrichPerson(apolloId: string): Promise<ApolloEnrichedPerson | null> {
  const apiKey = getApiKey();

  const response = await fetch(
    `${APOLLO_BASE_URL}/people/match?id=${encodeURIComponent(apolloId)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Apollo enrich failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { person?: ApolloEnrichedPerson };

  if (!data.person) {
    return null;
  }

  return data.person;
}
