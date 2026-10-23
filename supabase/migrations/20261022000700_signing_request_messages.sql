alter table public.signing_requests
  add column if not exists request_message text
  check (request_message is null or length(request_message) <= 2000);

create table if not exists public.signing_request_messages (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.signing_requests (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  sender_name text not null,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists signing_request_messages_request_created_idx
  on public.signing_request_messages (request_id, created_at, id);

alter table public.signing_request_messages enable row level security;
revoke all on public.signing_request_messages from public, anon, authenticated;
grant select on public.signing_request_messages to authenticated;

drop policy if exists signing_request_messages_select_participant on public.signing_request_messages;
create policy signing_request_messages_select_participant
  on public.signing_request_messages for select to authenticated
  using (public.can_access_signing_request(request_id));

create or replace function public.send_signing_request_message(
  p_request_id uuid,
  p_body text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_sender_name text;
  v_message_id bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in to reply to a sign-off request.';
  end if;
  if not public.can_access_signing_request(p_request_id) then
    raise exception 'You are not a participant in this sign-off request.';
  end if;
  if length(v_body) not between 1 and 2000 then
    raise exception 'Messages must contain between 1 and 2000 characters.';
  end if;

  select profile.display_name
  into v_sender_name
  from public.user_profiles as profile
  where profile.user_id = auth.uid();

  insert into public.signing_request_messages (request_id, sender_id, sender_name, body)
  values (p_request_id, auth.uid(), coalesce(v_sender_name, 'User'), v_body)
  returning id into v_message_id;

  return v_message_id;
end;
$$;

revoke all on function public.send_signing_request_message(uuid, text) from public, anon;
grant execute on function public.send_signing_request_message(uuid, text) to authenticated;
