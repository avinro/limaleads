import { describe, it, expect } from 'vitest';
import { detectLanguageFromCountry } from './language';

describe('detectLanguageFromCountry', () => {
  it('returns "de" for DE', () => {
    expect(detectLanguageFromCountry('DE')).toBe('de');
  });

  it('returns "de" for AT', () => {
    expect(detectLanguageFromCountry('AT')).toBe('de');
  });

  it('returns "de" for CH', () => {
    expect(detectLanguageFromCountry('CH')).toBe('de');
  });

  it('is case-insensitive', () => {
    expect(detectLanguageFromCountry('de')).toBe('de');
    expect(detectLanguageFromCountry('At')).toBe('de');
  });

  it('trims surrounding whitespace', () => {
    expect(detectLanguageFromCountry('  DE  ')).toBe('de');
  });

  it('returns "en" for non-DACH countries', () => {
    expect(detectLanguageFromCountry('GB')).toBe('en');
    expect(detectLanguageFromCountry('US')).toBe('en');
    expect(detectLanguageFromCountry('IT')).toBe('en');
    expect(detectLanguageFromCountry('IL')).toBe('en');
    expect(detectLanguageFromCountry('HU')).toBe('en');
  });

  it('returns "en" for null', () => {
    expect(detectLanguageFromCountry(null)).toBe('en');
  });

  it('returns "en" for undefined', () => {
    expect(detectLanguageFromCountry(undefined)).toBe('en');
  });

  it('returns "en" for empty string', () => {
    expect(detectLanguageFromCountry('')).toBe('en');
  });

  it('returns "en" for unknown country codes', () => {
    expect(detectLanguageFromCountry('ZZ')).toBe('en');
  });
});
