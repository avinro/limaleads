// Renders a template body by substituting {{placeholder}} tokens with lead data.
// Used by the follow-up scheduler to produce per-lead follow-up email bodies
// without calling Gemini (follow-up bodies use operator-authored copy, not AI).

export interface TemplateLeadContext {
  name: string | null;
  company: string | null;
  title: string | null;
  linkedin_url: string | null;
}

/**
 * Replaces all occurrences of {{name}}, {{company}}, {{title}}, and
 * {{linkedin_url}} in the template body with corresponding lead values.
 * Null or undefined values are replaced with an empty string so the output
 * is always a complete string with no leftover tokens.
 */
export function renderTemplate(body: string, lead: TemplateLeadContext): string {
  return body
    .replaceAll('{{name}}', lead.name ?? '')
    .replaceAll('{{company}}', lead.company ?? '')
    .replaceAll('{{title}}', lead.title ?? '')
    .replaceAll('{{linkedin_url}}', lead.linkedin_url ?? '');
}
