// Helpers to build Gemini-ready company context from Apollo enrichment data.
//
// buildCompanyHook — produces a compact 1-2 sentence string that Gemini weaves
//   into the email's opening hook.
//
// deriveCountryFromApollo — extracts an ISO-ish country code from the org or
//   person object so the poller can populate leads.country without a separate
//   API call. Returns null rather than guessing.

import type { ApolloEnrichedPerson, ApolloOrganization } from '../integrations/apolloClient';

const MAX_DESCRIPTION_CHARS = 200;

// ---------------------------------------------------------------------------
// Array safety helpers
// ---------------------------------------------------------------------------

/**
 * Ensures a value from Apollo is a usable string array. Apollo may return
 * null, undefined, a non-array, or an array containing non-string elements.
 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

// ---------------------------------------------------------------------------
// buildCompanyHook
// ---------------------------------------------------------------------------

/**
 * Builds a compact 1-2 sentence company context string for the Gemini prompt.
 *
 * Strategy (in order of preference):
 *   1. short_description (truncated to MAX_DESCRIPTION_CHARS).
 *   2. Fallback: "${industry} company; keywords: ${top 3 keywords}".
 *   3. Returns null if there is no usable signal.
 *
 * The result is stored in leads.company_hook and passed verbatim to the
 * Gemini prompt as "Company hook: ...". Keep it factual and compact so the
 * model has enough to personalize without being overwhelmed.
 */
export function buildCompanyHook(
  org: ApolloOrganization | null,
  person: ApolloEnrichedPerson | null,
): string | null {
  if (!org && !person) return null;

  // Prefer the human-readable description.
  const description = org?.short_description?.trim();
  if (description) {
    const truncated =
      description.length > MAX_DESCRIPTION_CHARS
        ? description.slice(0, MAX_DESCRIPTION_CHARS).trimEnd() + '…'
        : description;
    return truncated;
  }

  // Fall back to industry + top keywords.
  const industry = org?.industry?.trim();
  const keywords = toStringArray(org?.keywords).slice(0, 3);

  if (industry && keywords.length > 0) {
    return `${industry} company; keywords: ${keywords.join(', ')}`;
  }

  if (industry) {
    return `${industry} company`;
  }

  if (keywords.length > 0) {
    return `Keywords: ${keywords.join(', ')}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// deriveCountryFromApollo
// ---------------------------------------------------------------------------

/**
 * Attempts to derive an ISO-ish country code from Apollo enrichment data.
 *
 * Priority order:
 *   1. Organization HQ country (org.hq_country or org.country).
 *   2. Person's personal country (person.country).
 *
 * Returns null rather than guessing — callers must handle the null case and
 * not default to a language without explicit signal.
 */
export function deriveCountryFromApollo(
  org: ApolloOrganization | null,
  person: ApolloEnrichedPerson | null,
): string | null {
  // Prefer org HQ country — more stable for language targeting than person's
  // current location, which may differ from the company's locale.
  const orgCountry = (org?.hq_country ?? org?.country)?.trim() || null;
  if (orgCountry) return orgCountry;

  const personCountry = person?.country?.trim() || null;
  if (personCountry) return personCountry;

  return null;
}
