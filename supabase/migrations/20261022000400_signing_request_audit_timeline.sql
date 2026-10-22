create table if not exists public.signing_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.signing_requests (id) on delete cascade,
  event_type text not null check (event_type in (
    'request_created',
    'request_started',
    'request_completed',
    'request_cancelled',
    'request_status_changed',
    'signer_signed'
  )),
  actor_id uuid,
  actor_name text,
  signer_order smallint,
  from_status text,
  to_status text,
  created_at timestamptz not null default now()
);

create index if not exists signing_request_events_request_created_idx
  on public.signing_request_events (request_id, created_at, id);

alter table public.signing_request_events enable row level security;
revoke all on public.signing_request_events from public, anon, authenticated;
grant select on public.signing_request_events to authenticated;

drop policy if exists signing_request_events_select_participant on public.signing_request_events;
create policy signing_request_events_select_participant
  on public.signing_request_events for select to authenticated
  using (public.can_access_signing_request(request_id));

create or replace function private.audit_signing_request_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_type text;
  v_actor_id uuid;
  v_actor_name text;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'request_created';
    v_actor_id := new.owner_id;
    select profile.display_name
    into v_actor_name
    from public.user_profiles as profile
    where profile.user_id = v_actor_id;

    insert into public.signing_request_events (
      request_id, event_type, actor_id, actor_name, to_status
    )
    values (
      new.id, v_event_type, v_actor_id, coalesce(v_actor_name, 'User'), new.status
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    v_event_type := case
      when old.status = 'draft' and new.status = 'pending' then 'request_started'
      when new.status = 'completed' then 'request_completed'
      when new.status = 'cancelled' then 'request_cancelled'
      else 'request_status_changed'
    end;
    v_actor_id := auth.uid();
    select profile.display_name
    into v_actor_name
    from public.user_profiles as profile
    where profile.user_id = v_actor_id;

    insert into public.signing_request_events (
      request_id, event_type, actor_id, actor_name, from_status, to_status
    )
    values (
      new.id, v_event_type, v_actor_id, v_actor_name, old.status, new.status
    );
  end if;
  return new;
end;
$$;

revoke all on function private.audit_signing_request_change() from public, anon, authenticated;

drop trigger if exists audit_signing_request_insert on public.signing_requests;
create trigger audit_signing_request_insert
after insert on public.signing_requests
for each row execute function private.audit_signing_request_change();

drop trigger if exists audit_signing_request_status_change on public.signing_requests;
create trigger audit_signing_request_status_change
after update of status on public.signing_requests
for each row
when (old.status is distinct from new.status)
execute function private.audit_signing_request_change();

create or replace function private.audit_signing_request_signer_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_name text;
begin
  if old.status is distinct from new.status and new.status = 'signed' then
    select profile.display_name
    into v_actor_name
    from public.user_profiles as profile
    where profile.user_id = new.signer_id;

    insert into public.signing_request_events (
      request_id, event_type, actor_id, actor_name, signer_order
    )
    values (
      new.request_id,
      'signer_signed',
      new.signer_id,
      coalesce(v_actor_name, 'User'),
      new.signer_order
    );
  end if;
  return new;
end;
$$;

revoke all on function private.audit_signing_request_signer_change() from public, anon, authenticated;

drop trigger if exists audit_signing_request_signer_status_change on public.signing_request_signers;
create trigger audit_signing_request_signer_status_change
after update of status on public.signing_request_signers
for each row
when (old.status is distinct from new.status)
execute function private.audit_signing_request_signer_change();
