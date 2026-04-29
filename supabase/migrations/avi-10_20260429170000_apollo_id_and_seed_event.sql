-- AVI-10: Add apollo_id to leads and extend transition_lead_status RPC to support
-- an idempotent seed event (null → 'new') for newly-inserted leads.

-- ---------------------------------------------------------------------------
-- 1. apollo_id column on leads
-- ---------------------------------------------------------------------------
-- Non-unique: same Apollo person may re-appear under a different email.
-- Indexed for future lookups (e.g. detecting profile updates).
alter table public.leads
  add column if not exists apollo_id text;

create index if not exists idx_leads_apollo_id on public.leads (apollo_id);

-- ---------------------------------------------------------------------------
-- 2. Extend transition_lead_status RPC with a seed-event path.
--
-- Problem: the poller inserts a lead with status='new' (DB default), then
-- calls transitionLeadStatus(id, 'new', 'system') to write the audit event.
-- The original RPC only validates transitions from the allowed map, which
-- does not include 'new' → 'new'.
--
-- Solution: add a seed-event branch that fires when:
--   p_actor     = 'system'
--   p_to_status = 'new'
--   current DB status is already 'new' (just inserted)
--
-- Behaviour:
--   - If a seed event (from_status IS NULL, to_status = 'new') already exists
--     for this lead, return it without inserting a duplicate (idempotent retry).
--   - Otherwise insert the seed event and return it.
--   - Lead status is NOT updated (already 'new').
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
  -- Validate actor value.
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

  -- Seed-event path: poller calls this immediately after INSERT to record the
  -- initial 'new' status in the audit log. The lead is already 'new' (DB
  -- default), so we only write/return the audit event.
  if p_actor = 'system' and p_to_status = 'new' and v_from_status = 'new' then
    -- Idempotent: return the existing seed event if one was already written.
    select * into v_event
    from public.lead_status_events
    where lead_id     = p_lead_id
      and from_status is null
      and to_status   = 'new'
    limit 1;

    if found then
      return v_event;
    end if;

    -- Write the seed event (from_status = null signals "initial creation").
    insert into public.lead_status_events (lead_id, from_status, to_status, actor, reason)
    values (p_lead_id, null, 'new', p_actor, p_reason)
    returning * into v_event;

    return v_event;
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
