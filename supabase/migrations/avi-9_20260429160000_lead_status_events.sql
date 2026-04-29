-- AVI-9: Lead state machine — audit table + atomic transition RPC.
-- All status changes must go through transition_lead_status(); direct
-- UPDATE leads SET status = ... is forbidden by convention.

create table if not exists public.lead_status_events (
  id          uuid        primary key default gen_random_uuid(),
  lead_id     uuid        not null references public.leads(id) on delete cascade,
  from_status text,
  to_status   text        not null,
  actor       text        not null check (actor in ('system', 'manual', 'override')),
  reason      text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Valid transitions map encoded as a 2-column table expression.
-- Keeping it in SQL means the DB enforces it even if callers bypass the TS
-- wrapper.
--
-- State machine:
--   new -> draft_created -> contacted -> replied -> closed_won / closed_lost / disqualified
--                                    -> follow_up_scheduled -> follow_up_sent
--                                                           -> replied
--                                                           -> exhausted -> disqualified
--                                                           -> follow_up_scheduled  (re-schedule loop)
--
-- Manual override: actor='manual' may transition any non-terminal state to
-- 'disqualified' (reason required).
-- ---------------------------------------------------------------------------
create or replace function public.transition_lead_status(
  p_lead_id   uuid,
  p_to_status text,
  p_actor     text,
  p_reason    text default null
)
returns public.lead_status_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_status text;
  v_event       public.lead_status_events;
  v_allowed     boolean := false;
begin
  -- Validate actor value (mirrors the check constraint on lead_status_events).
  if p_actor not in ('system', 'manual', 'override') then
    raise exception 'Invalid actor: %. Must be system, manual, or override.', p_actor
      using errcode = 'invalid_parameter_value';
  end if;

  -- Manual transitions require a non-empty reason.
  if p_actor = 'manual' and (p_reason is null or trim(p_reason) = '') then
    raise exception 'reason is required for manual transitions'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lock the lead row to prevent concurrent transitions on the same lead.
  select status into v_from_status
  from public.leads
  where id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead % not found', p_lead_id
      using errcode = 'no_data_found';
  end if;

  -- Check transition is allowed.
  -- Manual actor may always transition to 'disqualified' from any non-terminal state.
  if p_actor = 'manual'
     and p_to_status = 'disqualified'
     and v_from_status not in ('closed_won', 'closed_lost', 'disqualified')
  then
    v_allowed := true;
  end if;

  -- System/automatic transitions validated against the state machine.
  if not v_allowed then
    v_allowed := (v_from_status, p_to_status) in (
      ('new',                  'draft_created'),
      ('draft_created',        'contacted'),
      ('contacted',            'replied'),
      ('contacted',            'follow_up_scheduled'),
      ('follow_up_scheduled',  'follow_up_sent'),
      ('follow_up_sent',       'replied'),
      ('follow_up_sent',       'exhausted'),
      ('follow_up_sent',       'follow_up_scheduled'),
      ('replied',              'closed_won'),
      ('replied',              'closed_lost'),
      ('replied',              'disqualified'),
      ('exhausted',            'disqualified')
    );
  end if;

  if not v_allowed then
    raise exception 'Invalid transition: % -> %', v_from_status, p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Apply the transition.
  update public.leads
  set status = p_to_status
  where id = p_lead_id;

  -- Write audit event.
  insert into public.lead_status_events (lead_id, from_status, to_status, actor, reason)
  values (p_lead_id, v_from_status, p_to_status, p_actor, p_reason)
  returning * into v_event;

  return v_event;
end;
$$;
