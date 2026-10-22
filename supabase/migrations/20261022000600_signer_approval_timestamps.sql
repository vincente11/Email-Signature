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
          'status', signer.status,
          'signed_at', signer.signed_at
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
