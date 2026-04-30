-- AVI-12: Add draft_subject and draft_body snapshot columns to leads.
-- These columns are populated by AVI-13 (draft creator) at the moment a Gmail
-- draft is created, so that AVI-19 (sent detector) can later detect edits
-- by comparing the sent message body against the original generated content.
-- Neither column has a NOT NULL constraint because leads created before AVI-13
-- ships will have no draft snapshot.

alter table public.leads
  add column if not exists draft_subject text,
  add column if not exists draft_body    text;
