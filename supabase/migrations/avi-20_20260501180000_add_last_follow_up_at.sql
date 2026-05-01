-- AVI-20: Add last_follow_up_at to track when the most recent follow-up was
-- actually sent (set by sent detection, not draft creation).
-- Used by the eligibility query to compute the delay for the second follow-up
-- correctly: coalesce(last_follow_up_at, contacted_at) < now() - follow_up_days.
-- Without this column, the second follow-up would fire immediately after the
-- first because contacted_at would still be the reference.

alter table public.leads
  add column if not exists last_follow_up_at timestamptz;

-- Update the default follow_up_body to match the Atelierra voice established
-- in AVI-17. The previous seed text used "branded merchandise" language and
-- client references that conflict with the approved brand voice.
update public.templates
set follow_up_body =
  E'Hi {{name}},\n\n' ||
  E'just following up on my note about fashion-level merch for {{company}}.\n\n' ||
  E'Atelierra creates capsule-style pieces for teams and communities, produced ' ||
  E'in Europe, so the result feels closer to a collection than standard merch.\n\n' ||
  E'Would it be useful if I sent over a few directions that could fit {{company}}?\n\n' ||
  E'Best,'
where name = 'Default B2B Outreach';
