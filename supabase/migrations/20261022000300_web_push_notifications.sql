create extension if not exists pg_net with schema extensions;

create table if not exists public.push_subscriptions (
  endpoint text primary key check (length(endpoint) between 1 and 2048),
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null check (length(p256dh) between 1 and 256),
  auth text not null check (length(auth) between 1 and 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_chrome check (
    endpoint ~ '^https://fcm\.googleapis\.com/fcm/send/[^[:space:]]+$'
  )
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;

create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to enable browser alerts.';
  end if;
  if p_endpoint is null or length(p_endpoint) > 2048
     or p_endpoint !~ '^https://fcm\.googleapis\.com/fcm/send/[^[:space:]]+$' then
    raise exception 'The browser returned an unsupported Chrome push endpoint.';
  end if;
  if p_p256dh is null or length(p_p256dh) not between 1 and 256
     or p_auth is null or length(p_auth) not between 1 and 128 then
    raise exception 'The browser returned an invalid push subscription.';
  end if;

  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth, updated_at)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, now())
  on conflict (endpoint) do update
  set user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

create or replace function public.remove_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to turn off browser alerts.';
  end if;

  delete from public.push_subscriptions
  where endpoint = p_endpoint
    and user_id = auth.uid();
end;
$$;

revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.remove_push_subscription(text) to authenticated;

create or replace function private.send_signing_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_push_secret text;
begin
  select secret.decrypted_secret
  into v_push_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'efficient_sign_push_sender_secret'
  limit 1;

  if v_push_secret is null then
    raise warning 'Web push is not configured: add the efficient_sign_push_sender_secret to Supabase Vault.';
    return new;
  end if;

  perform net.http_post(
    url := 'https://mvfnycefnmpwtuoajliq.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('request_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-push-secret', v_push_secret
    ),
    timeout_milliseconds := 2000
  );

  return new;
end;
$$;

revoke all on function private.send_signing_push() from public, anon, authenticated;

drop trigger if exists send_signing_push_on_request_change on public.signing_requests;
create trigger send_signing_push_on_request_change
after update of status, active_signer_position on public.signing_requests
for each row
when (
  old.status is distinct from new.status
  or old.active_signer_position is distinct from new.active_signer_position
)
execute function private.send_signing_push();
