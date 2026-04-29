-- Base schema for LimaLeads MVP.
-- Creates templates, leads, and job_log with constraints and timestamps.
-- gen_random_uuid() is built-in since PostgreSQL 13; no extension needed.

create table if not exists public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  body text not null,
  follow_up_body text,
  follow_up_days integer not null default 4 check (follow_up_days > 0),
  active boolean not null default true
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  company text,
  title text,
  linkedin_url text,
  source_criteria text,
  status text not null default 'new' check (
    status in (
      'new',
      'draft_created',
      'contacted',
      'replied',
      'follow_up_scheduled',
      'follow_up_sent',
      'exhausted',
      'closed_won',
      'closed_lost',
      'disqualified'
    )
  ),
  template_id uuid references public.templates (id) on delete set null,
  gmail_draft_id text,
  gmail_thread_id text,
  contacted_at timestamptz,
  replied_at timestamptz,
  follow_up_count integer not null default 0 check (follow_up_count >= 0),
  edited_before_send boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_log (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- clock_timestamp() returns wall-clock time, unlike now() which returns
  -- the transaction start time and would be identical to created_at when
  -- INSERT and UPDATE run in the same transaction.
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

drop trigger if exists trg_leads_set_updated_at on public.leads;
create trigger trg_leads_set_updated_at
before update on public.leads
for each row
execute function public.set_updated_at();
