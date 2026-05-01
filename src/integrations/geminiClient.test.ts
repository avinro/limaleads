import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateEmail,
  buildPromptForTest,
  CTA_EN,
  CTA_DE_M,
  CTA_DE_F,
  CTA_DE_NEUTRAL,
} from './geminiClient';
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
  companyHook: 'A premium automotive accessories brand targeting urban professionals.',
};

const germanLead: LeadContext = {
  name: 'Tobias Freundlieb',
  title: 'Head of Brand Experience',
  company: 'Sixt',
  linkedinUrl: null,
  sourceCriteria: 'Brand experience leader in DACH',
  country: 'DE',
  language: 'de',
  companyHook: null,
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
// Tests — response parsing
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
// Tests — prompt content: Atelierra brand voice
// ---------------------------------------------------------------------------

describe('buildPromptForTest — Atelierra brand voice', () => {
  it('mentions Atelierra by name', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain('Atelierra');
  });

  it('positions the product as fashion-level merch and forbids "branded merchandise" framing', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain('fashion-level merch');
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

  it('requires anti-marketing-copy tone — no stacked adjectives or filler', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/stacked adjectives/i);
    expect(prompt).toMatch(/no fluff/i);
  });

  it('requires first-name-only greeting', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/ONLY the lead.*first name/i);
  });

  it('requires a concrete use-case for corporate or enterprise leads', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/welcome kit|trade fair|onboarding pack/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content: language switching
// ---------------------------------------------------------------------------

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

  it('embeds the English CTA verbatim for English leads', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain(CTA_EN);
  });

  it('embeds all German CTA variants verbatim for German leads', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toContain(CTA_DE_M);
    expect(prompt).toContain(CTA_DE_F);
    expect(prompt).toContain(CTA_DE_NEUTRAL);
  });

  it('forbids mixing languages in the output', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Do not mix languages/);
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content: German-specific rules
// ---------------------------------------------------------------------------

describe('buildPromptForTest — German rules (only in DE prompt)', () => {
  it('requires du-form (no Sie/Ihr/Ihnen) for German', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/du.*form/i);
    expect(prompt).toMatch(/Never.*Sie.*Ihr/);
  });

  it('forbids empty praise ("Als X bei Y wissen Sie") for German', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/No empty praise/i);
    expect(prompt).toMatch(/wissen Sie/);
  });

  it('requires English fashion vocabulary (anglicisms) for German', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Fashion-Pieces/);
    expect(prompt).toMatch(/Avoid.*Mode-Pieces/i);
  });

  it('requires "Kein" not "Nicht" before nouns in German', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Kein.*not.*Nicht/i);
    expect(prompt).toContain('Kein Standard-Merch');
  });

  it('instructs conservative gender inference with a neutral fallback', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/Infer gender ONLY from common.*first names/i);
    expect(prompt).toMatch(/Unsure.*unisex.*international.*shortened.*ambiguous/i);
    expect(prompt).toMatch(/use exactly.*Ansprechpartner\/in/i);
  });

  it('does NOT inject German-only rules for an English lead', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).not.toMatch(/Always use the informal.*du.*form/);
    expect(prompt).not.toMatch(/Kein.*not.*Nicht/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content: subject line rules
// ---------------------------------------------------------------------------

describe('buildPromptForTest — subject line rules', () => {
  it('specifies 2-6 word punchy German subject rule', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toMatch(/2-6 words/);
    expect(prompt).toMatch(/punchy/i);
  });

  it('specifies concise 5-9 word English subject rule', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/5-9 words/);
    expect(prompt).toMatch(/concise/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content: lead context
// ---------------------------------------------------------------------------

describe('buildPromptForTest — lead context', () => {
  it('includes the lead name, title, company, and country', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toContain('Tobias Freundlieb');
    expect(prompt).toContain('Head of Brand Experience');
    expect(prompt).toContain('Sixt');
    expect(prompt).toContain('Country: DE');
  });

  it('includes Company hook line with value when companyHook is present', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toContain(
      'Company hook: A premium automotive accessories brand targeting urban professionals.',
    );
  });

  it('shows em-dash placeholder when companyHook is null', () => {
    const prompt = buildPromptForTest(germanLead, template);
    expect(prompt).toContain('Company hook: —');
  });
});

// ---------------------------------------------------------------------------
// Tests — prompt content: companyHook global rule
// ---------------------------------------------------------------------------

describe('buildPromptForTest — companyHook global rule', () => {
  it('instructs Gemini to weave ONE concrete fact from the company hook', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/Company hook.*weave ONE concrete fact/i);
    expect(prompt).toMatch(/Do not list multiple facts/i);
  });

  it('instructs paraphrasing, not verbatim copy', () => {
    const prompt = buildPromptForTest(englishLead, template);
    expect(prompt).toMatch(/paraphrase naturally/i);
  });
});
