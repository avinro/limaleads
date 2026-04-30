import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateEmail } from './geminiClient';
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

const lead: LeadContext = {
  name: 'Jane Doe',
  title: 'Head of Marketing',
  company: 'Acme Corp',
  linkedinUrl: 'https://linkedin.com/in/janedoe',
  sourceCriteria: 'Head of Marketing in Spain',
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
// Tests
// ---------------------------------------------------------------------------

describe('generateEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('parses a valid JSON response', async () => {
    mockResponse(JSON.stringify({ subject: 'Hello Jane', body: 'Great work at Acme.' }));

    const result = await generateEmail(lead, template);

    expect(result.subject).toBe('Hello Jane');
    expect(result.body).toBe('Great work at Acme.');
  });

  it('strips markdown code fences before parsing JSON', async () => {
    mockResponse('```json\n{"subject":"Hi","body":"Let me explain."}\n```');

    const result = await generateEmail(lead, template);

    expect(result.subject).toBe('Hi');
    expect(result.body).toBe('Let me explain.');
  });

  it('parses plain-text Subject:/body format', async () => {
    mockResponse('Subject: Quick question\nI wanted to reach out about your role at Acme.');

    const result = await generateEmail(lead, template);

    expect(result.subject).toBe('Quick question');
    expect(result.body).toBe('I wanted to reach out about your role at Acme.');
  });

  it('throws when the response is malformed', async () => {
    mockResponse('This is not JSON and has no Subject line.');

    await expect(generateEmail(lead, template)).rejects.toThrow(
      'Gemini returned unexpected format',
    );
  });

  it('throws before calling the API when GEMINI_API_KEY is missing', async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(generateEmail(lead, template)).rejects.toThrow(
      'Missing required environment variable: GEMINI_API_KEY',
    );

    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
