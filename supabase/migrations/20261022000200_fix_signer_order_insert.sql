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
