import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEmail, buildPromptForTest, CTA_EN, CTA_DE } from './geminiClient';
import type { LeadContext, TemplateContext } from './geminiClient';

// ---------------------------------------------------------------------------
// Mock @google/generative-ai
// vi.hoisted ensures mockGenerateContent is available inside the hoisted factory
// ---------------------------------------------------------------------------

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}));

vi.mock('@google/generative-ai', () => ({
  // Must be a regular function (not arrow) so `new GoogleGenerativeAI()` works
  GoogleGenerativeAI: vi.fn(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
      }),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const englishLead: LeadContext = {
  name: 'Jane Doe',
  title: 'Head of Marketing',
  company: 'Acme Corp',
  linkedinUrl: 'https://linkedin.com/in/janedoe',
  sourceCriteria: 'Head of Marketing in UK',
  country: 'GB',
  language: 'en',
};

const germanLead: LeadContext = {
  name: 'Tobias Freundlieb',
  title: 'Head of Brand Experience',
  company: 'Sixt',
  linkedinUrl: null,
  sourceCriteria: 'Brand experience leader in DACH',
  country: 'DE',
  language: 'de',
};

const template: TemplateContext = {
  body: 'Hi {{name}}, I noticed your work at {{company}} and wanted to connect.',
};

function mockResponse(text: string) {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => text },
  });
}

// ---------------------------------------------------------------------------
// Tests — response parsing (preserved from AVI-16)
// ---------------------------------------------------------------------------

describe('generateEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('parses a valid JSON response', async () => {
    mockResponse(JSON.stringify({ subject: 'Hello Jane', body: 'Great work at Acme.' }));

    const result = await generateEmail(englishLead, template);

    expect(result.subject).toBe('Hello Jane');
    expect(result.body).toBe('Great work at Acme.');
  });

  it('strips markdown code fences before parsing JSON', async () => {
    mockResponse('```json\n{"subject":"Hi","body":"Let me explain."}\n```');

    const result = await generateEmail(englishLead, template);

    expect(result.subject).toBe('Hi');
    expect(result.body).toBe('Let me explain.');
  });

  it('parses plain-text Subject:/body format', async () => {
    mockResponse('Subject: Quick question\nI wanted to reach out about your role at Acme.');

    const result = await generateEmail(englishLead, template);

    expect(result.subject).toBe('Quick question');
    expect(result.body).toBe('I wanted to reach out about your role at Acme.');
  });

  it('throws when the response is malformed', async () => {
    mockResponse('This is not JSON and has no Subject line.');

    await expect(generateEmail(englishLead, template)).rejects.toThrow(
      'Gemini returned unexpected format',
    );
  });

  it('throws before calling the API when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(generateEmail(englishLead, template)).rejects.toThrow(
      'Missing required environment variable: GEMINI_API_KEY',
    );

    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content (AVI-17 Atelierra voice & localization)
// ---------------------------------------------------------------------------

describe('buildPromptForTest — Atelierra brand voice', () => {
  it('mentions Atelierra by name', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain('Atelierra');
  });

  it('positions the product as fashion-level merch and forbids "branded merchandise" framing', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain('fashion-level merch');
    // The brand voice rule must explicitly forbid the wrong framing.
    expect(prompt).toMatch(/never "branded merchandise"/);
  });

  it('forbids name-dropping unrelated past clients', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/Do NOT name-drop/i);
  });

  it('demands JSON output contract', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/JSON object/);
    expect(prompt).toContain('"subject"');
    expect(prompt).toContain('"body"');
  });

  it('enforces a 60-110 word body length', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/60 to 110 words/);
  });
});

describe('buildPromptForTest — language switching', () => {
  it('instructs Gemini to respond in English for non-DACH leads', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/Respond ONLY in English/);
    expect(prompt).not.toMatch(/Respond ONLY in German/);
  });

  it('instructs Gemini to respond in German for DACH leads', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Respond ONLY in German/);
    expect(prompt).not.toMatch(/Respond ONLY in English/);
  });

  it('embeds the localized English CTA verbatim for English leads', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain(CTA_EN);
  });

  it('embeds the localized German CTA verbatim for German leads', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toContain(CTA_DE);
  });

  it('forbids mixing languages in the output', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Do not mix languages/);
  });
});

describe('buildPromptForTest — lead context', () => {
  it('includes the lead name, title, company, and country', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toContain('Tobias Freundlieb');
    expect(prompt).toContain('Head of Brand Experience');
    expect(prompt).toContain('Sixt');
    expect(prompt).toContain('Country: DE');
  });
});
