import { describe, it, expect } from 'vitest';
import { buildCompanyHook, deriveCountryFromApollo } from './companyHook';
import type { ApolloEnrichedPerson, ApolloOrganization } from '../integrations/apolloClient';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOrg(overrides: Partial<ApolloOrganization> = {}): ApolloOrganization {
  return {
    name: 'Acme Corp',
    short_description: null,
    industry: null,
    keywords: null,
    technology_names: null,
    ...overrides,
  };
}

function makePerson(overrides: Partial<ApolloEnrichedPerson> = {}): ApolloEnrichedPerson {
  return {
    id: 'apollo-1',
    name: 'Jane Doe',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@acme.com',
    title: 'CEO',
    linkedin_url: null,
    organization: null,
    headline: null,
    departments: null,
    seniority: null,
    country: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCompanyHook
// ---------------------------------------------------------------------------

describe('buildCompanyHook — short_description path', () => {
  it('returns the description when short_description is present', () => {
    const org = makeOrg({ short_description: 'A premium automotive brand based in Munich.' });
    expect(buildCompanyHook(org, null)).toBe('A premium automotive brand based in Munich.');
  });

  it('truncates descriptions longer than 200 chars and appends ellipsis', () => {
    const long = 'A'.repeat(201);
    const org = makeOrg({ short_description: long });
    const result = buildCompanyHook(org, null);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(201); // 200 chars + '…'
    expect(result!.endsWith('…')).toBe(true);
  });

  it('trims whitespace from short_description before use', () => {
    const org = makeOrg({ short_description: '  Trimmed description.  ' });
    expect(buildCompanyHook(org, null)).toBe('Trimmed description.');
  });
});

describe('buildCompanyHook — fallback path', () => {
  it('returns industry + keywords when no short_description', () => {
    const org = makeOrg({ industry: 'automotive', keywords: ['luxury', 'premium', 'mobility'] });
    expect(buildCompanyHook(org, null)).toBe(
      'automotive company; keywords: luxury, premium, mobility',
    );
  });

  it('caps keywords at top 3', () => {
    const org = makeOrg({
      industry: 'fintech',
      keywords: ['payments', 'crypto', 'banking', 'savings', 'investing'],
    });
    const result = buildCompanyHook(org, null);
    expect(result).toBe('fintech company; keywords: payments, crypto, banking');
  });

  it('returns industry alone when keywords is empty', () => {
    const org = makeOrg({ industry: 'defense', keywords: [] });
    expect(buildCompanyHook(org, null)).toBe('defense company');
  });

  it('returns keywords alone when industry is null', () => {
    const org = makeOrg({ industry: null, keywords: ['fashion', 'luxury'] });
    expect(buildCompanyHook(org, null)).toBe('Keywords: fashion, luxury');
  });
});

describe('buildCompanyHook — null returns', () => {
  it('returns null when org and person are both null', () => {
    expect(buildCompanyHook(null, null)).toBeNull();
  });

  it('returns null when org has no usable fields', () => {
    const org = makeOrg({ short_description: null, industry: null, keywords: null });
    expect(buildCompanyHook(org, null)).toBeNull();
  });

  it('returns null when keywords is null', () => {
    const org = makeOrg({ industry: null, keywords: null });
    expect(buildCompanyHook(org, null)).toBeNull();
  });
});

describe('buildCompanyHook — malformed arrays', () => {
  it('ignores non-string entries in keywords', () => {
    const org = makeOrg({
      // Apollo may return mixed types in practice
      keywords: [42, 'valid', null, 'also-valid'] as unknown as string[],
    });
    const result = buildCompanyHook(org, null);
    expect(result).toBe('Keywords: valid, also-valid');
  });

  it('treats an empty keywords array the same as null when industry is also absent', () => {
    const org = makeOrg({ industry: null, keywords: [] });
    expect(buildCompanyHook(org, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deriveCountryFromApollo
// ---------------------------------------------------------------------------

describe('deriveCountryFromApollo', () => {
  it('returns org hq_country first', () => {
    const org = makeOrg({ hq_country: 'DE', country: 'US' });
    const person = makePerson({ country: 'FR' });
    expect(deriveCountryFromApollo(org, person)).toBe('DE');
  });

  it('falls back to org.country when hq_country is absent', () => {
    const org = makeOrg({ hq_country: null, country: 'AT' });
    const person = makePerson({ country: 'FR' });
    expect(deriveCountryFromApollo(org, person)).toBe('AT');
  });

  it('falls back to person.country when org has no country', () => {
    const org = makeOrg({ hq_country: null, country: null });
    const person = makePerson({ country: 'IL' });
    expect(deriveCountryFromApollo(org, person)).toBe('IL');
  });

  it('returns null when all sources are null', () => {
    const org = makeOrg({ hq_country: null, country: null });
    const person = makePerson({ country: null });
    expect(deriveCountryFromApollo(org, person)).toBeNull();
  });

  it('returns null when both org and person are null', () => {
    expect(deriveCountryFromApollo(null, null)).toBeNull();
  });

  it('trims whitespace from country values', () => {
    const org = makeOrg({ hq_country: '  CH  ' });
    expect(deriveCountryFromApollo(org, null)).toBe('CH');
  });

  it('treats empty string country as null', () => {
    const org = makeOrg({ hq_country: '', country: '' });
    const person = makePerson({ country: 'NL' });
    expect(deriveCountryFromApollo(org, person)).toBe('NL');
  });
});
