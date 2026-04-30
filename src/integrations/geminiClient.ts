// Gemini 2.5 Flash client — generates personalized Atelierra outreach emails.
//
// Prompt design (AVI-17, supersedes the AVI-16 PRD-verbatim prompt for eval):
//   - Atelierra brand voice: fashion-level merch, produced in Europe.
//   - Five labeled style examples drawn from the client's first emails so
//     Gemini can pick the most appropriate angle per lead.
//   - Localized output and CTA driven by `LeadContext.language`.
//
// The output contract is unchanged: `{ subject, body }` JSON.

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Language } from '../lib/language';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadContext {
  name: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  sourceCriteria: string | null;
  country: string | null;
  language: Language;
}

export interface TemplateContext {
  body: string;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Client setup
// ---------------------------------------------------------------------------

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Missing required environment variable: GEMINI_API_KEY');
  }

  return new GoogleGenerativeAI(apiKey);
}

// ---------------------------------------------------------------------------
// Localized CTAs — kept as constants so tests can assert verbatim presence.
// ---------------------------------------------------------------------------

export const CTA_EN =
  'Are you the right person to talk to about this, or could you point me to someone on your brand or marketing team?';

export const CTA_DE =
  'Bist du die/der richtige Ansprechpartner/in dafür, oder kannst du mich an jemanden im Brand- oder Marketing-Team weiterleiten?';

// ---------------------------------------------------------------------------
// Few-shot examples (anonymized) — 5 client patterns from AVI-17 review.
// ---------------------------------------------------------------------------

const STYLE_EXAMPLES = `Style 1 — Personalized hook (use when there is a specific public fact about the company)
Hello FirstName,
we're Atelierra and we produce fashion-level merch for companies that care about their appearance.
I came across BrandX on LinkedIn and the energy you're putting into the brand, so I figured it was worth a shot.
For BrandX, we would love to put together a collection for your team and community. We want to create fashion pieces that your team and community actually want to wear. Produced in Europe.
I would love to walk you through a few ideas and hear what matters most to you.
${CTA_EN}

Style 2 — Lifestyle angle (use when the brand is consumer-facing or aspirational)
Hello FirstName,
we're Atelierra and we realize fashion-level merch for brands who care about their appearance.
We see a trend of many brands becoming lifestyle-brands and that's where we see an opportunity for BrandX.
We want to create fashion pieces with you that your team and community actually want to wear.
Not standard merch, but a high-quality capsule collection that translates BrandX's brand into fashion, produced in Europe.
${CTA_EN}

Style 3 — "You already have merch, we can do it better" (use when the company already sells merch)
Hello FirstName,
we're Atelierra and we realize fashion-level merch for brands who care about their appearance.
We've seen your current collection and see room to elevate it. We would love to put together a capsule that your team and community actually want to wear, produced in Europe.
${CTA_EN}

Style 4 — Iconic places → wearable collections (use for venues, festivals, museums, bars)
Hallo liebes BrandX-Team,
mein Name ist Leonard und gemeinsam mit der Firma Atelierra verwandeln wir die Identität ikonischer Orte in tragbare Kollektionen.
Vor kurzem haben wir eine Kollektion für die Rooftop Bar Astral in Madrid fertiggestellt.
In City sehen wir bei BrandX Potenzial für eine ähnliche Kollektion auf Fashion-Niveau.
Falls das für euch interessant klingt, erzähle ich euch gerne mehr.

Style 5 — Standard fashion-level merch (default when no specific hook is available)
Hallo FirstName,
wir sind Atelierra und wir realisieren Merch auf Fashion-Niveau für Brands, die auf ihr Erscheinungsbild achten.
Wir würden gerne mit euch zusammen Fashion-Pieces realisieren, die so gut aussehen, dass sie euer Team und eure Community tatsächlich tragen würden.
Kein Standard-Merch, sondern eine Fashion-Kollektion, mit der die BrandX-Brand in Fashion übersetzt wird. Produziert in Europa.
${CTA_DE}`;

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(lead: LeadContext, template: TemplateContext): string {
  const name = lead.name ?? 'Unknown';
  const title = lead.title ?? 'Unknown';
  const company = lead.company ?? 'Unknown';
  const linkedinUrl = lead.linkedinUrl ?? '';
  const sourceCriteria = lead.sourceCriteria ?? '';
  const country = lead.country ?? '';

  const isGerman = lead.language === 'de';
  const languageLabel = isGerman ? 'German' : 'English';
  const cta = isGerman ? CTA_DE : CTA_EN;

  return `System: You are a B2B sales assistant writing on behalf of Atelierra, a Berlin-based studio that produces fashion-level merch and capsule collections in Europe for brands that care about their appearance. Tone: professional but not stiff. No filler phrases. No fake intimacy.

Brand voice rules (apply to every email):
- Open with the Atelierra identity ("we're Atelierra and we ..." or "wir sind Atelierra und wir ...").
- Position the product as "fashion-level merch", "fashion collections", or "capsule collection" — never "branded merchandise" or "promotional gifts".
- Mention "produced in Europe" / "produziert in Europa" once.
- Frame value as: pieces the team and community actually want to wear.
- Do NOT name-drop unrelated past clients (e.g. Allianz, Klarna, Sixt). Only reference past work when it is contextually relevant to the lead.

Style examples (pick the angle that fits the lead best):
${STYLE_EXAMPLES}

Context for this lead:
  Lead: ${name}, ${title} at ${company}
  Country: ${country}
  LinkedIn: ${linkedinUrl}
  Source filter used: ${sourceCriteria}

Reference template (operator-supplied tone reference, may be partially applicable):
  ${template.body}

Output rules (strict):
- Respond ONLY in ${languageLabel}. Do not mix languages anywhere in subject or body.
- Body length: 60 to 110 words.
- The body MUST end with this exact CTA on its own line:
${cta}
- Insert at least one specific, non-generic hook based on the lead's title, company, country, or sourceCriteria.
- Output a single JSON object with exactly two string fields: {"subject": "...", "body": "..."}. No commentary, no markdown fences.`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parses the Gemini response text into a GeneratedEmail.
 *
 * Attempts JSON parsing first (most reliable). Falls back to a Subject/body
 * plain-text format in case the model ignores the template instructions and
 * responds in prose. Throws if neither format is recognized.
 */
function parseResponse(text: string): GeneratedEmail {
  const trimmed = text.trim();

  // Strategy 1: JSON object
  const candidates = [
    trimmed,
    // Strip markdown code fences if present
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
  ];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).subject === 'string' &&
        typeof (parsed as Record<string, unknown>).body === 'string'
      ) {
        const { subject, body } = parsed as GeneratedEmail;
        return { subject, body };
      }
    } catch {
      // not JSON — try next strategy
    }
  }

  // Strategy 2: plain text with "Subject:" prefix on the first line
  const subjectMatch = trimmed.match(/^Subject:\s*(.+)\n([\s\S]+)$/i);

  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    const body = subjectMatch[2].trim();

    if (subject && body) {
      return { subject, body };
    }
  }

  throw new Error(`Gemini returned unexpected format: ${trimmed}`);
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Generates a personalized Atelierra outreach email for a lead.
 * Returns { subject, body }.
 * Throws on API failure or unparseable response — callers handle status transitions.
 *
 * Test seam: the prompt builder is exported so unit tests can assert on prompt
 * contents (Atelierra voice, CTA localization, language switch) without
 * mocking the Gemini SDK end-to-end.
 */
export function buildPromptForTest(lead: LeadContext, template: TemplateContext): string {
  return buildPrompt(lead, template);
}

export async function generateEmail(
  lead: LeadContext,
  template: TemplateContext,
): Promise<GeneratedEmail> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = buildPrompt(lead, template);
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  return parseResponse(text);
}
