create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  email text not null,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from public, anon, authenticated;

create or replace function private.sync_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := coalesce(
    nullif(btrim(concat_ws(
      ' ',
      nullif(btrim(new.raw_user_meta_data ->> 'first_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'last_name'), '')
    )), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(new.email, ''), '@', 1),
    'User'
  );

  insert into public.user_profiles (user_id, display_name, email, updated_at)
  values (new.id, v_display_name, coalesce(new.email, ''), now())
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      email = excluded.email,
      updated_at = excluded.updated_at;

  return new;
end;
$$;

drop trigger if exists sync_user_profile_insert on auth.users;
create trigger sync_user_profile_insert
after insert on auth.users
for each row execute function private.sync_user_profile();

drop trigger if exists sync_user_profile_update on auth.users;
create trigger sync_user_profile_update
after update of email, raw_user_meta_data on auth.users
for each row execute function private.sync_user_profile();

insert into public.user_profiles (user_id, display_name, email, updated_at)
select
  users.id,
  coalesce(
    nullif(btrim(concat_ws(
      ' ',
      nullif(btrim(users.raw_user_meta_data ->> 'first_name'), ''),
      nullif(btrim(users.raw_user_meta_data ->> 'last_name'), '')
    )), ''),
    nullif(btrim(users.raw_user_meta_data ->> 'display_name'), ''),
    nullif(btrim(users.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(users.raw_user_meta_data ->> 'name'), ''),
    split_part(coalesce(users.email, ''), '@', 1),
    'User'
  ),
  coalesce(users.email, ''),
  now()
from auth.users as users
on conflict (user_id) do update
set display_name = excluded.display_name,
    email = excluded.email,
    updated_at = excluded.updated_at;

create table if not exists public.signing_requests (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  file_name text not null check (length(file_name) between 1 and 255),
  storage_path text not null unique,
  status text not null default 'draft'
    check (status in ('draft', 'pending', 'completed', 'cancelled')),
  active_signer_position smallint not null default 1 check (active_signer_position > 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint signing_requests_storage_path_matches_id
    check (storage_path = id::text || '/document.pdf'),
  constraint signing_requests_completion_matches_status
    check ((status = 'completed') = (completed_at is not null))
);

create table if not exists public.signing_request_signers (
  request_id uuid not null references public.signing_requests (id) on delete cascade,
  signer_id uuid not null references auth.users (id) on delete cascade,
  signer_order smallint not null check (signer_order > 0),
  status text not null default 'pending' check (status in ('pending', 'signed')),
  signed_at timestamptz,
  primary key (request_id, signer_id),
  unique (request_id, signer_order),
  constraint signing_request_signers_signed_at_matches_status
    check ((status = 'signed') = (signed_at is not null))
);

create index if not exists signing_requests_owner_created_idx
  on public.signing_requests (owner_id, created_at desc);
create index if not exists signing_request_signers_user_status_idx
  on public.signing_request_signers (signer_id, status, request_id);

alter table public.signing_requests enable row level security;
alter table public.signing_request_signers enable row level security;
revoke all on public.signing_requests, public.signing_request_signers from public, anon, authenticated;
grant select, insert, delete on public.signing_requests to authenticated;
grant select on public.signing_request_signers to authenticated;

create or replace function public.can_access_signing_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (
      exists (
        select 1
        from public.signing_requests as request
        where request.id = p_request_id
          and request.owner_id = auth.uid()
      )
      or exists (
        select 1
        from public.signing_request_signers as signer
        where signer.request_id = p_request_id
          and signer.signer_id = auth.uid()
      )
    );
$$;

revoke all on function public.can_access_signing_request(uuid) from public, anon;
grant execute on function public.can_access_signing_request(uuid) to authenticated;

drop policy if exists signing_requests_select_participant on public.signing_requests;
create policy signing_requests_select_participant
  on public.signing_requests for select to authenticated
  using (public.can_access_signing_request(id));

drop policy if exists signing_requests_insert_owner_draft on public.signing_requests;
create policy signing_requests_insert_owner_draft
  on public.signing_requests for insert to authenticated
  with check (
    owner_id = auth.uid()
    and status = 'draft'
    and active_signer_position = 1
    and completed_at is null
    and storage_path = id::text || '/document.pdf'
  );

drop policy if exists signing_requests_delete_owner_draft on public.signing_requests;
create policy signing_requests_delete_owner_draft
  on public.signing_requests for delete to authenticated
  using (owner_id = auth.uid() and status = 'draft');

drop policy if exists signing_request_signers_select_participant on public.signing_request_signers;
create policy signing_request_signers_select_participant
  on public.signing_request_signers for select to authenticated
  using (public.can_access_signing_request(request_id));

create or replace function public.search_signing_users(p_query text)
returns table (user_id uuid, display_name text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to search for signers.';
  end if;
  if length(v_query) < 2 or length(v_query) > 100 then
    return;
  end if;

  return query
  select profile.user_id, profile.display_name, profile.email
  from public.user_profiles as profile
  where profile.user_id <> auth.uid()
    and (
      position(v_query in lower(profile.display_name)) > 0
      or position(v_query in lower(profile.email)) > 0
    )
  order by profile.display_name, profile.email
  limit 20;
end;
$$;

revoke all on function public.search_signing_users(text) from public, anon;
grant execute on function public.search_signing_users(text) to authenticated;

create or replace function public.start_signing_request(
  p_request_id uuid,
  p_signer_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.signing_requests%rowtype;
  v_signer_count integer;
  v_distinct_count integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a sign-off request.';
  end if;
  if p_signer_ids is null or cardinality(p_signer_ids) < 1 or cardinality(p_signer_ids) > 10 then
    raise exception 'Select between 1 and 10 signers.';
  end if;

  select count(distinct requested.signer_id)
  into v_distinct_count
  from unnest(p_signer_ids) as requested(signer_id);
  if v_distinct_count <> cardinality(p_signer_ids) then
    raise exception 'A signer can only appear once in a request.';
  end if;
  if auth.uid() = any(p_signer_ids) then
    raise exception 'You cannot request sign-off from yourself.';
  end if;

  select count(*)
  into v_signer_count
  from public.user_profiles as profile
  where profile.user_id = any(p_signer_ids);
  if v_signer_count <> cardinality(p_signer_ids) then
    raise exception 'One or more selected users are no longer available.';
  end if;

  select *
  into v_request
  from public.signing_requests as request
  where request.id = p_request_id
  for update;
  if not found or v_request.owner_id <> auth.uid() or v_request.status <> 'draft' then
    raise exception 'The sign-off request could not be started.';
  end if;
  if not exists (
    select 1
    from storage.objects as stored_object
    where stored_object.bucket_id = 'signing-documents'
      and stored_object.name = v_request.storage_path
  ) then
    raise exception 'Upload the PDF before starting the sign-off request.';
  end if;

  insert into public.signing_request_signers (request_id, signer_id, signer_order)
  select p_request_id, requested.signer_id, requested.signer_order::smallint
  from unnest(p_signer_ids) with ordinality as requested(signer_id, signer_order);

  update public.signing_requests
  set status = 'pending', active_signer_position = 1
  where id = p_request_id;
end;
$$;

revoke all on function public.start_signing_request(uuid, uuid[]) from public, anon;
grant execute on function public.start_signing_request(uuid, uuid[]) to authenticated;

create or replace function public.complete_signing_step(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_position smallint;
  v_next_position smallint;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to sign this document.';
  end if;

  select request.active_signer_position
  into v_active_position
  from public.signing_requests as request
  where request.id = p_request_id and request.status = 'pending'
  for update;
  if not found then
    raise exception 'This sign-off request is no longer active.';
  end if;

  update public.signing_request_signers as signer
  set status = 'signed', signed_at = now()
  where signer.request_id = p_request_id
    and signer.signer_id = auth.uid()
    and signer.signer_order = v_active_position
    and signer.status = 'pending';
  if not found then
    raise exception 'It is not your turn to sign this document.';
  end if;

  select min(signer.signer_order)
  into v_next_position
  from public.signing_request_signers as signer
  where signer.request_id = p_request_id and signer.status = 'pending';

  if v_next_position is null then
    update public.signing_requests
    set status = 'completed', completed_at = now()
    where id = p_request_id;
    return 'completed';
  end if;

  update public.signing_requests
  set active_signer_position = v_next_position
  where id = p_request_id;
  return 'pending';
end;
$$;

revoke all on function public.complete_signing_step(uuid) from public, anon;
grant execute on function public.complete_signing_step(uuid) to authenticated;

create or replace function public.list_signing_requests()
returns table (
  request_id uuid,
  owner_id uuid,
  owner_name text,
  file_name text,
  storage_path text,
  status text,
  active_signer_position smallint,
  my_position smallint,
  my_status text,
  signer_count bigint,
  signers jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    request.id,
    request.owner_id,
    coalesce(owner_profile.display_name, 'User'),
    request.file_name,
    request.storage_path,
    request.status,
    request.active_signer_position,
    my_signer.signer_order,
    my_signer.status,
    signer_summary.signer_count,
    signer_summary.signers,
    request.created_at
  from public.signing_requests as request
  left join public.user_profiles as owner_profile on owner_profile.user_id = request.owner_id
  left join public.signing_request_signers as my_signer
    on my_signer.request_id = request.id and my_signer.signer_id = auth.uid()
  left join lateral (
    select
      count(*) as signer_count,
      jsonb_agg(
        jsonb_build_object(
          'user_id', signer.signer_id,
          'display_name', coalesce(profile.display_name, 'User'),
          'email', coalesce(profile.email, ''),
          'position', signer.signer_order,
          'status', signer.status
        ) order by signer.signer_order
      ) as signers
    from public.signing_request_signers as signer
    left join public.user_profiles as profile on profile.user_id = signer.signer_id
    where signer.request_id = request.id
  ) as signer_summary on true
  where auth.uid() is not null
    and (request.owner_id = auth.uid() or my_signer.signer_id = auth.uid())
  order by request.created_at desc
  limit 100;
$$;

revoke all on function public.list_signing_requests() from public, anon;
grant execute on function public.list_signing_requests() to authenticated;

create or replace function public.can_access_signing_document(
  p_request_id uuid,
  p_action text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.signing_requests as request
    where request.id = p_request_id
      and (
        (p_action = 'create' and request.owner_id = auth.uid() and request.status = 'draft')
        or (
          p_action = 'read'
          and (
            request.owner_id = auth.uid()
            or exists (
              select 1
              from public.signing_request_signers as signer
              where signer.request_id = request.id
                and signer.signer_id = auth.uid()
                and (
                  request.status = 'completed'
                  or
                  signer.status = 'signed'
                  or (signer.status = 'pending' and signer.signer_order = request.active_signer_position)
                )
            )
          )
        )
        or (
          p_action = 'sign'
          and request.status = 'pending'
          and exists (
            select 1
            from public.signing_request_signers as signer
            where signer.request_id = request.id
              and signer.signer_id = auth.uid()
              and signer.status = 'pending'
              and signer.signer_order = request.active_signer_position
          )
        )
        or (p_action = 'delete' and request.owner_id = auth.uid() and request.status = 'draft')
      )
  );
$$;

revoke all on function public.can_access_signing_document(uuid, text) from public, anon;
grant execute on function public.can_access_signing_document(uuid, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signing-documents', 'signing-documents', false, 52428800, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists signing_documents_read_participant on storage.objects;
create policy signing_documents_read_participant
  on storage.objects for select to authenticated
  using (
    bucket_id = 'signing-documents'
    and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/document\.pdf$'
    and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'read')
  );

drop policy if exists signing_documents_insert_draft_owner on storage.objects;
drop policy if exists signing_documents_insert_owner_or_active_signer on storage.objects;
create policy signing_documents_insert_owner_or_active_signer
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'signing-documents'
    and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/document\.pdf$'
    and (
      public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'create')
      or public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'sign')
    )
  );

drop policy if exists signing_documents_update_active_signer on storage.objects;
create policy signing_documents_update_active_signer
  on storage.objects for update to authenticated
  using (
    bucket_id = 'signing-documents'
    and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/document\.pdf$'
    and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'sign')
  )
  with check (
    bucket_id = 'signing-documents'
    and name ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/document\.pdf$'
    and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'sign')
  );

drop policy if exists signing_documents_delete_draft_owner on storage.objects;
create policy signing_documents_delete_draft_owner
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'signing-documents'
    and name ~ '^[0-9a-fA-F-]{36}/document\.pdf$'
    and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'delete')
  );
