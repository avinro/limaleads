// Gemini Flash client — generates personalized outreach emails from lead context.
// Uses gemini-2.5-flash for speed and cost efficiency at MVP scale.

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadContext {
  firstName: string;
  lastName: string | null;
  title: string | null;
  company: string | null;
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
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(lead: LeadContext, isFollowUp: number = 0): string {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  const role = lead.title ?? 'professional';
  const company = lead.company ?? 'your company';

  const followUpContext =
    isFollowUp > 0
      ? `This is follow-up number ${isFollowUp}. Keep it short, reference the previous email without repeating it, and add new value or a different angle.`
      : 'This is the initial outreach email.';

  return `You are a senior sales consultant writing a cold outreach email on behalf of LimaLeads, a B2B sales intelligence platform that helps companies find and connect with decision-makers.

Lead details:
- Name: ${name}
- Title: ${role}
- Company: ${company}

${followUpContext}

Write a personalized, professional cold email. Requirements:
- Subject line: concise, relevant, no clickbait
- Body: 3-4 short paragraphs max
- Tone: professional but conversational, not pushy
- Personalize based on their role and company
- End with a clear, low-friction call to action (e.g. a 15-minute call)
- Do NOT use filler phrases like "I hope this email finds you well"
- Do NOT use excessive exclamation marks

Respond with ONLY a valid JSON object in this exact format, no markdown, no extra text:
{"subject": "...", "body": "..."}`;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Generates a personalized outreach email for a lead.
 * Pass followUp=1 or followUp=2 for follow-up sequences.
 */
export async function generateEmail(
  lead: LeadContext,
  followUp: number = 0,
): Promise<GeneratedEmail> {
  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = buildPrompt(lead, followUp);
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    // Gemini occasionally wraps JSON in markdown code fences — strip and retry
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(stripped);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).subject !== 'string' ||
    typeof (parsed as Record<string, unknown>).body !== 'string'
  ) {
    throw new Error(`Gemini returned unexpected format: ${text}`);
  }

  const { subject, body } = parsed as GeneratedEmail;

  return { subject, body };
}
