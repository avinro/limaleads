// AVI-17: Language detection from a lead's country code.
//
// DACH leads (Germany, Austria, Switzerland) get German emails; everything
// else falls back to English. Country is matched case-insensitively so the
// helper tolerates lowercase or mixed-case ISO-2 strings from any source.

export type Language = 'en' | 'de';

const GERMAN_SPEAKING_COUNTRIES = new Set(['DE', 'AT', 'CH']);

export function detectLanguageFromCountry(country: string | null | undefined): Language {
  if (!country) {
    return 'en';
  }

  return GERMAN_SPEAKING_COUNTRIES.has(country.trim().toUpperCase()) ? 'de' : 'en';
}
