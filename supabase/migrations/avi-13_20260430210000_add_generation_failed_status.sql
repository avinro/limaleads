-- AVI-13: Add generation_failed to the leads status check constraint.
-- The draft creator (AVI-13) transitions a lead to this status when the
-- Gmail API call or template fetch fails, so the pipeline can surface and
-- retry failed leads without leaving them stuck in 'new'.

-- Postgres auto-names inline check constraints as <table>_<column>_check.
alter table public.leads
  drop constraint if exists leads_status_check;

alter table public.leads
  add constraint leads_status_check check (
    status in (
      'new',
      'draft_created',
      'generation_failed',
      'contacted',
      'replied',
      'follow_up_scheduled',
      'follow_up_sent',
      'exhausted',
      'closed_won',
      'closed_lost',
      'disqualified'
    )
  );
