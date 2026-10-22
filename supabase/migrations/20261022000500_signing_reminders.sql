alter table public.signing_request_events
  drop constraint if exists signing_request_events_event_type_check;

alter table public.signing_request_events
  add constraint signing_request_events_event_type_check
  check (event_type in (
    'request_created',
    'request_started',
    'request_completed',
    'request_cancelled',
    'request_status_changed',
    'signer_signed',
    'reminder_sent'
  ));

create table if not exists public.signing_reminder_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  opted_out boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.signing_reminder_preferences enable row level security;
revoke all on public.signing_reminder_preferences from public, anon, authenticated;
grant select on public.signing_reminder_preferences to authenticated;

drop policy if exists signing_reminder_preferences_select_self on public.signing_reminder_preferences;
create policy signing_reminder_preferences_select_self
  on public.signing_reminder_preferences for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.set_signing_reminder_opt_out(p_opted_out boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to update reminder preferences.';
  end if;
  if p_opted_out is null then
    raise exception 'Choose whether to opt out of signing reminders.';
  end if;

  insert into public.signing_reminder_preferences (user_id, opted_out, updated_at)
  values (auth.uid(), p_opted_out, now())
  on conflict (user_id) do update
  set opted_out = excluded.opted_out,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.set_signing_reminder_opt_out(boolean) from public, anon;
grant execute on function public.set_signing_reminder_opt_out(boolean) to authenticated;

create or replace function public.send_signing_reminder(p_request_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.signing_requests%rowtype;
  v_signer_id uuid;
  v_signer_order smallint;
  v_last_reminder timestamptz;
  v_actor_name text;
  v_push_secret text;
  v_reminder_sent_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to send a reminder.';
  end if;

  select *
  into v_request
  from public.signing_requests as request
  where request.id = p_request_id
  for update;

  if not found or v_request.owner_id <> auth.uid() then
    raise exception 'Only the request owner can send a reminder.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Reminders are only available for active requests.';
  end if;

  select signer.signer_id, signer.signer_order
  into v_signer_id, v_signer_order
  from public.signing_request_signers as signer
  where signer.request_id = p_request_id
    and signer.signer_order = v_request.active_signer_position
    and signer.status = 'pending';
  if not found then
    raise exception 'There is no current signer to remind.';
  end if;

  if exists (
    select 1
    from public.signing_reminder_preferences as preference
    where preference.user_id = v_signer_id
      and preference.opted_out
  ) then
    raise exception 'The current signer has opted out of signing reminders.';
  end if;

  if not exists (
    select 1
    from public.push_subscriptions as subscription
    where subscription.user_id = v_signer_id
  ) then
    raise exception 'The current signer has not enabled browser push alerts.';
  end if;

  select max(event.created_at)
  into v_last_reminder
  from public.signing_request_events as event
  where event.request_id = p_request_id
    and event.event_type = 'reminder_sent'
    and event.signer_order = v_signer_order;
  if v_last_reminder is not null and v_last_reminder > v_reminder_sent_at - interval '24 hours' then
    raise exception 'A reminder was already sent to this signer in the last 24 hours.';
  end if;

  select profile.display_name
  into v_actor_name
  from public.user_profiles as profile
  where profile.user_id = auth.uid();

  insert into public.signing_request_events (
    request_id, event_type, actor_id, actor_name, signer_order
  )
  values (
    p_request_id, 'reminder_sent', auth.uid(), coalesce(v_actor_name, 'User'), v_signer_order
  );

  select secret.decrypted_secret
  into v_push_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'efficient_sign_push_sender_secret'
  limit 1;
  if v_push_secret is null then
    raise exception 'Push sender is not configured in Supabase Vault.';
  end if;

  perform net.http_post(
    url := 'https://mvfnycefnmpwtuoajliq.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('request_id', p_request_id, 'reminder', true),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_push_secret
    ),
    timeout_milliseconds := 2000
  );

  return v_reminder_sent_at;
end;
$$;

revoke all on function public.send_signing_reminder(uuid) from public, anon;
grant execute on function public.send_signing_reminder(uuid) to authenticated;
