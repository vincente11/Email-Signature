begin;

create table if not exists public.direct_messages (
  id bigint generated always as identity primary key,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  client_message_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender_id <> recipient_id),
  unique (sender_id, client_message_id)
);
create index if not exists direct_messages_sender_idx on public.direct_messages(sender_id, recipient_id, id desc);
create index if not exists direct_messages_recipient_idx on public.direct_messages(recipient_id, sender_id, id desc);
create index if not exists direct_messages_unread_idx on public.direct_messages(recipient_id, sender_id) where read_at is null;
alter table public.direct_messages enable row level security;
revoke all on public.direct_messages from public, anon, authenticated;
grant select on public.direct_messages to authenticated;
create policy direct_messages_participants on public.direct_messages
  for select to authenticated using (auth.uid() = sender_id or auth.uid() = recipient_id);

create or replace function public.send_direct_message(p_recipient_id uuid, p_body text, p_client_message_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_id bigint;
  v_existing public.direct_messages%rowtype;
begin
  if v_user is null then raise exception 'Sign in to send messages.'; end if;
  if p_recipient_id is null or p_recipient_id = v_user or not exists (
    select 1 from public.user_profiles where user_id = p_recipient_id
  ) then raise exception 'Choose another registered user.'; end if;
  if length(v_body) not between 1 and 2000 or p_client_message_id is null then
    raise exception 'Messages must contain between 1 and 2000 characters.';
  end if;
  -- Serialize a sender's requests so retries cannot duplicate messages or bypass limits.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));
  select * into v_existing from public.direct_messages where sender_id = v_user and client_message_id = p_client_message_id;
  if found then
    if v_existing.recipient_id <> p_recipient_id or v_existing.body <> v_body then raise exception 'Message retry does not match the original.'; end if;
    return v_existing.id::text;
  end if;
  if (select count(*) from public.direct_messages where sender_id = v_user and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'Please wait a moment before sending more messages.';
  end if;
  insert into public.direct_messages(sender_id, recipient_id, client_message_id, body)
  values (v_user, p_recipient_id, p_client_message_id, v_body) returning id into v_id;
  return v_id::text;
end;
$$;

create or replace function public.list_direct_conversations()
returns table(peer_id uuid, display_name text, email text, last_body text, last_at timestamptz, unread_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view chats.'; end if;
  return query
  with mine as (
    select m.*, case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end as peer
    from public.direct_messages m where m.sender_id = auth.uid() or m.recipient_id = auth.uid()
  ), latest as (
    select distinct on (m.peer) m.peer, m.body, m.created_at, m.id from mine m order by m.peer, m.id desc
  ), unread as (
    select m.peer, count(*) as total from mine m where m.recipient_id = auth.uid() and m.read_at is null group by m.peer
  )
  select l.peer, p.display_name, p.email, l.body, l.created_at, coalesce(u.total, 0)
  from latest l join public.user_profiles p on p.user_id = l.peer left join unread u on u.peer = l.peer
  order by l.id desc;
end;
$$;

create or replace function public.get_direct_messages(p_peer_id uuid, p_before bigint default null, p_after bigint default null)
returns table(id text, sender_id uuid, body text, created_at timestamptz, read_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view messages.'; end if;
  if p_before is not null and p_after is not null then raise exception 'Choose one pagination direction.'; end if;
  return query select batch.id::text, batch.sender_id, batch.body, batch.created_at, batch.read_at from (
    select m.* from public.direct_messages m
    where ((m.sender_id = auth.uid() and m.recipient_id = p_peer_id) or (m.sender_id = p_peer_id and m.recipient_id = auth.uid()))
      and (p_before is null or m.id < p_before) and (p_after is null or m.id > p_after)
    order by case when p_after is not null then m.id end asc, m.id desc
    limit case when p_after is not null then 100 else 50 end
  ) batch order by batch.id;
end;
$$;

create or replace function public.mark_direct_messages_read(p_peer_id uuid, p_through bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to read messages.'; end if;
  update public.direct_messages set read_at = now()
  where recipient_id = auth.uid() and sender_id = p_peer_id and id <= p_through and read_at is null;
end;
$$;

revoke all on function public.send_direct_message(uuid,text,uuid) from public, anon;
revoke all on function public.list_direct_conversations() from public, anon;
revoke all on function public.get_direct_messages(uuid,bigint,bigint) from public, anon;
revoke all on function public.mark_direct_messages_read(uuid,bigint) from public, anon;
grant execute on function public.send_direct_message(uuid,text,uuid) to authenticated;
grant execute on function public.list_direct_conversations() to authenticated;
grant execute on function public.get_direct_messages(uuid,bigint,bigint) to authenticated;
grant execute on function public.mark_direct_messages_read(uuid,bigint) to authenticated;
notify pgrst, 'reload schema';
commit;
