// Gemini 2.5 Flash client — generates personalized Atelierra outreach emails.
//
// Prompt design (AVI-17 iteration 3, adds companyHook from Apollo enrichment):
//   - Atelierra brand voice: fashion-level merch, produced in Europe.
//   - Global rules: first-name only greeting, no AI marketing copy, use-case
//     hints for corporate leads, weave ONE fact from companyHook when present.
//   - German-specific rules: du form, no empty praise, anglicisms, Kein not
//     Nicht, conservative gender-aware CTA.
//   - Subject line rules: punchy German (2-6 words), concise English (5-9).
//   - Five labeled style examples drawn from client's first emails.
//   - Localized output and CTA driven by LeadContext.language.
//   - Output contract: { subject, body } JSON.

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
  // AVI-17 iter 3: pre-built company context string from Apollo enrichment.
  // Gemini weaves ONE fact from this into the hook line. Null when not yet enriched.
  companyHook: string | null;
}

export interface TemplateContext {
  body: string;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Localized CTAs
//
// CTA_EN       — used for all English emails.
// CTA_DE_M     — German masculine (clearly male first name).
// CTA_DE_F     — German feminine (clearly female first name).
// CTA_DE_NEUTRAL — German neutral fallback for ambiguous / unisex names.
//
// Exported so tests can assert verbatim presence in the prompt.
// ---------------------------------------------------------------------------

export const CTA_EN =
  'Are you the right person to talk to about this, or could you point me to someone on your brand or marketing team?';

export const CTA_DE_M =
  'Bist du der richtige Ansprechpartner dafür, oder kannst du mich an jemanden im Brand- oder Marketing-Team weiterleiten?';

export const CTA_DE_F =
  'Bist du die richtige Ansprechpartnerin dafür, oder kannst du mich an jemanden im Brand- oder Marketing-Team weiterleiten?';

export const CTA_DE_NEUTRAL =
  'Bist du die/der richtige Ansprechpartner/in dafür, oder kannst du mich an jemanden im Brand- oder Marketing-Team weiterleiten?';

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
// Prompt builder — iteration 2
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

  // ---------------------------------------------------------------------------
  // Global rules — apply to every email regardless of language
  // ---------------------------------------------------------------------------
  const globalRules = `Global rules (apply to every email):
- Brand: you write on behalf of Atelierra, a Berlin studio producing fashion-level merch and capsule collections in Europe for brands that care about their appearance.
- Open with the Atelierra identity ("we're Atelierra and we ..." or "wir sind Atelierra und wir ...").
- Position the product as "fashion-level merch", "fashion collections", or "capsule collection" — never "branded merchandise" or "promotional gifts".
- Mention "produced in Europe" / "produziert in Europa" once.
- Greeting: use ONLY the lead's first name. "Hallo Tobias" not "Hallo Tobias Freundlieb". "Hello Sofia" not "Hello Sofia Santos Tinoco".
- Avoid stacked adjectives and marketing-copy filler ("a landmark European event center", "a distinct global brand"). Write like a founder — short, concrete, no fluff.
- Do NOT name-drop unrelated past clients (e.g. Allianz, Klarna, Sixt). Only reference past work when contextually relevant.
- When the lead works at a large enterprise (corporate, bank, defense, insurance, consulting, airline, automotive), include ONE concrete use-case: welcome kit for new joiners, event merch for a trade fair, onboarding pack, or similar. Tie it to a real fact about the company when possible.
- Company hook: if the "Company hook" field in the lead context is not "—", weave ONE concrete fact from it into the email’s hook line. Do not list multiple facts. Do not repeat the hook verbatim — paraphrase naturally.`;

  // ---------------------------------------------------------------------------
  // German-specific rules — only injected when language === 'de'
  // ---------------------------------------------------------------------------
  const germanRules = isGerman
    ? `
German rules (ONLY for German emails — mandatory):
- Always use the informal "du" form. Never "Sie", "Ihr", "Ihnen". We do fashion, not law.
- No empty praise. Skip "Als X bei Y wissen Sie, wie wichtig…" or "kennen Sie die Kraft…". Get to the point.
- Use English fashion vocabulary: "Fashion-Pieces", "Capsule Collection", "Brand". Avoid "Mode-Pieces" or "Marken-Kollektion".
- Use "Kein" (not "Nicht") before nouns: "Kein Standard-Merch", never "Nicht Standard-Merch".
- CTA localization: infer gender ONLY from common, obvious first names.
  - Clearly masculine (e.g. Tobias, Christian, Jonas, Patrick, Marco): use exactly → ${CTA_DE_M}
  - Clearly feminine (e.g. Tina, Katharina, Geraldine, Valeria, Evgeniia): use exactly → ${CTA_DE_F}
  - Unsure, unisex, international, shortened, or ambiguous (e.g. Hex, Maud, Sam, Lia, Alex): use exactly → ${CTA_DE_NEUTRAL}
  - Never infer gender from company, title, or role.`
    : '';

  // ---------------------------------------------------------------------------
  // Subject rules
  // ---------------------------------------------------------------------------
  const subjectRules = `Subject line rules:
- German: 2-6 words, punchy and brand-anchored. Good: "Sixt als Fashion-Statement", "Fashion-Merch für Sixt", "NIVEA & Fashion-Kollektionen". Bad: "Fashion-Kollektionen für X" (too generic).
- English: concise and brand-anchored, usually 5-9 words. Do not force under 6 words if awkward. Bad: "Fashion-Level Collections for X" (too generic).`;

  // ---------------------------------------------------------------------------
  // Five style examples (anonymized) — from client's first emails, AVI-17 review
  // ---------------------------------------------------------------------------
  const styleExamples = `Style examples (pick the angle that best fits the lead — do NOT copy verbatim):

Style 1 — Personalized hook (use when there is a specific public fact about the company)
Hello FirstName,
we're Atelierra and we produce fashion-level merch for companies that care about their appearance.
I came across BrandX on LinkedIn and the energy you're putting into the brand, so I figured it was worth a shot.
For BrandX, we would love to put together a collection for your team and community. We want to create fashion pieces that your team and community actually want to wear. Produced in Europe.
I would love to walk you through a few ideas and hear what matters most to you.
${CTA_EN}

Style 2 — Lifestyle angle (use when the brand is consumer-facing or aspirational)
Hello FirstName,
we're Atelierra and we realize fashion-level merch for brands who care about their appearance.
We see a trend of brands becoming lifestyle-brands and that's where we see an opportunity for BrandX.
We want to create fashion pieces with you that your team and community actually want to wear.
Not standard merch, but a high-quality capsule collection that translates BrandX's brand into fashion, produced in Europe.
${CTA_EN}

Style 3 — "You already have merch, we can do it better" (use when the company already sells merch)
Hello FirstName,
we're Atelierra and we realize fashion-level merch for brands who care about their appearance.
We've seen your current collection and see room to elevate it. We would love to put together a capsule that your team and community actually want to wear, produced in Europe.
${CTA_EN}

Style 4 — Iconic places → wearable collections (use for venues, festivals, museums, bars)
Hallo FirstName,
wir sind Atelierra und wir realisieren Merch auf Fashion-Niveau für Brands, die auf ihr Erscheinungsbild achten.
Vor kurzem haben wir eine Kollektion für die Rooftop Bar Astral in Madrid fertiggestellt.
In City sehen wir bei BrandX Potenzial für eine ähnliche Kollektion auf Fashion-Niveau.
Falls das für euch interessant klingt, erzähle ich euch gerne mehr.
${CTA_DE_NEUTRAL}

Style 5 — Standard fashion-level merch (default when no specific hook is available)
Hallo FirstName,
wir sind Atelierra und wir realisieren Merch auf Fashion-Niveau für Brands, die auf ihr Erscheinungsbild achten.
Wir würden gerne mit euch zusammen Fashion-Pieces realisieren, die so gut aussehen, dass euer Team und eure Community sie tatsächlich tragen würden.
Kein Standard-Merch, sondern eine Fashion-Kollektion, mit der die BrandX-Brand in Fashion übersetzt wird. Produziert in Europa.
${CTA_DE_NEUTRAL}`;

  // ---------------------------------------------------------------------------
  // Output rules
  // ---------------------------------------------------------------------------
  const outputRules = `Output rules (strict):
- Respond ONLY in ${languageLabel}. Do not mix languages anywhere in subject or body.
- Body length: 60 to 110 words.
- Re-read the email before outputting. Check subject-verb agreement ("a collection that translates", not "that translate"). In German check "Kein" vs "Nicht" and that greeting uses only the first name.
- Output a single JSON object: {"subject": "...", "body": "..."}. No commentary, no markdown fences.`;

  return `${globalRules}
${germanRules}

${subjectRules}

${styleExamples}

Lead context:
  Name: ${name}
  Title: ${title}
  Company: ${company}
  Country: ${country}
  LinkedIn: ${linkedinUrl}
  Source filter used: ${sourceCriteria}
  Company hook: ${lead.companyHook ?? '—'}

Reference template (operator tone reference — adapt as needed):
  ${template.body}

${outputRules}`;
}

// ---------------------------------------------------------------------------
// Response parsing — unchanged from AVI-16
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
 * Test seam: buildPromptForTest is exported so unit tests can assert on
 * prompt contents without mocking the Gemini SDK end-to-end.
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
