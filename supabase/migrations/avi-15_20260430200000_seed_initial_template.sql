-- AVI-15: Seed initial outreach template.
-- Idempotent: skips insert if a template with the same name already exists.
-- Operators can edit this template directly in Supabase Studio — no code deploy needed.

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body text not null,
  follow_up_body text,
  follow_up_days integer not null default 4 check (follow_up_days > 0),
  active boolean not null default true
);

insert into public.templates (name, subject, body, follow_up_body, follow_up_days, active)
select
  'Default B2B Outreach',

  'Custom branded merch for {{company}}',

  -- Base email body. Gemini will use this as reference when generating personalised emails.
  -- Keep it under 120 words. No filler phrases. Professional but not stiff.
  -- Available placeholders: {{name}}, {{company}}, {{title}}, {{linkedin_url}}
  E'Hi {{name}},\n\n' ||
  E'I came across {{company}} and thought there might be a fit — we create custom branded merchandise that helps teams stand out at events, in the office, and beyond.\n\n' ||
  E'We''ve worked with companies like Allianz, Klarna, and Sixt to produce pieces people actually want to wear or use.\n\n' ||
  E'Would it make sense to share a few examples that could work for {{company}}?\n\n' ||
  E'Best,',

  -- Follow-up body sent if no reply after follow_up_days.
  -- References the original outreach so context is clear.
  E'Hi {{name}},\n\n' ||
  E'Just following up on my note from a few days ago about custom branded merchandise for {{company}}.\n\n' ||
  E'Happy to keep it short — would a quick look at what we''ve done for similar teams be useful?\n\n' ||
  E'Best,',

  4,    -- follow_up_days: send follow-up after 4 business days with no reply (PRD default)
  true  -- active: this template is picked up by the pipeline

where not exists (
  select 1 from public.templates where name = 'Default B2B Outreach'
);
