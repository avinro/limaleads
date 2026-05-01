import { describe, it, expect } from 'vitest';
import { renderTemplate, type TemplateLeadContext } from './templateRenderer';

const fullLead: TemplateLeadContext = {
  name: 'Sofia',
  company: 'Acme GmbH',
  title: 'Head of Marketing',
  linkedin_url: 'https://linkedin.com/in/sofia',
};

describe('renderTemplate', () => {
  it('replaces all four placeholders', () => {
    const body = 'Hi {{name}}, from {{company}} ({{title}}) — {{linkedin_url}}';
    expect(renderTemplate(body, fullLead)).toBe(
      'Hi Sofia, from Acme GmbH (Head of Marketing) — https://linkedin.com/in/sofia',
    );
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    const body = '{{name}} at {{company}}. Yes, {{name}}.';
    expect(renderTemplate(body, fullLead)).toBe('Sofia at Acme GmbH. Yes, Sofia.');
  });

  it('replaces null name with empty string', () => {
    const body = 'Hi {{name}},';
    expect(renderTemplate(body, { ...fullLead, name: null })).toBe('Hi ,');
  });

  it('replaces null company with empty string', () => {
    const body = 'merch for {{company}}.';
    expect(renderTemplate(body, { ...fullLead, company: null })).toBe('merch for .');
  });

  it('replaces null title with empty string', () => {
    const body = 'role: {{title}}';
    expect(renderTemplate(body, { ...fullLead, title: null })).toBe('role: ');
  });

  it('replaces null linkedin_url with empty string', () => {
    const body = 'profile: {{linkedin_url}}';
    expect(renderTemplate(body, { ...fullLead, linkedin_url: null })).toBe('profile: ');
  });

  it('returns body unchanged when no placeholders present', () => {
    const body = 'No tokens here.';
    expect(renderTemplate(body, fullLead)).toBe('No tokens here.');
  });

  it('leaves unknown tokens untouched', () => {
    const body = 'Hello {{unknown}} placeholder.';
    expect(renderTemplate(body, fullLead)).toBe('Hello {{unknown}} placeholder.');
  });

  it('handles empty body', () => {
    expect(renderTemplate('', fullLead)).toBe('');
  });

  it('handles all-null lead fields', () => {
    const body = '{{name}} / {{company}} / {{title}} / {{linkedin_url}}';
    expect(
      renderTemplate(body, { name: null, company: null, title: null, linkedin_url: null }),
    ).toBe(' /  /  / ');
  });
});
