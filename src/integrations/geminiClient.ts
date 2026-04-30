// Gemini 2.5 Flash client — generates personalized outreach emails from lead context.
// Uses the exact prompt structure defined in PRD Section 3.

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadContext {
  name: string | null;
  title: string | null;
  company: string | null;
  linkedinUrl: string | null;
  sourceCriteria: string | null;
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
// Prompt — verbatim from PRD Section 3, no additions
// ---------------------------------------------------------------------------

function buildPrompt(lead: LeadContext, template: TemplateContext): string {
  const name = lead.name ?? 'Unknown';
  const title = lead.title ?? 'Unknown';
  const company = lead.company ?? 'Unknown';
  const linkedinUrl = lead.linkedinUrl ?? '';
  const sourceCriteria = lead.sourceCriteria ?? '';

  return `System: You are a B2B sales assistant. Write concise, direct outreach emails.
        Tone: professional but not stiff. Max 120 words. No filler phrases.

Context:
  Lead: ${name}, ${title} at ${company}
  LinkedIn: ${linkedinUrl}
  Source filter used: ${sourceCriteria}

Template:
  ${template.body}

Task: Personalize the template for this lead.
      Insert at least one specific, non-generic hook based on their title or company.
      Output only the email body and subject line. No commentary.`;
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
 * Generates a personalized outreach email for a lead using the PRD prompt.
 * Returns { subject, body }.
 * Throws on API failure or unparseable response — callers handle status transitions.
 */
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
