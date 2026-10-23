-- Immutable, server-produced document versions. Install before deploying the updated frontend.
begin;
alter table public.signing_requests drop constraint signing_requests_storage_path_matches_id;
alter table public.signing_requests add constraint signing_requests_storage_path_matches_id
 check (storage_path = id::text || '/document.pdf' or storage_path ~ ('^' || id::text || '/versions/[0-9a-f-]{36}\.pdf$'));

-- Browsers may upload the original draft only; signed versions are written by the signing function.
drop policy if exists signing_documents_insert_owner_or_active_signer on storage.objects;
drop policy if exists signing_documents_update_active_signer on storage.objects;
create policy signing_documents_insert_draft_owner on storage.objects for insert to authenticated
 with check (bucket_id = 'signing-documents'
 and name ~ '^[0-9a-f-]{36}/document\.pdf$'
 and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'create'));
drop policy if exists signing_documents_read_participant on storage.objects;
create policy signing_documents_read_participant on storage.objects for select to authenticated
 using (bucket_id = 'signing-documents'
 and name ~ '^[0-9a-f-]{36}/(document\.pdf|versions/[0-9a-f-]{36}\.pdf)$'
 and public.can_access_signing_document(split_part(name, '/', 1)::uuid, 'read'));

-- Only the server may commit a version. The row lock and expected path reject stale tabs.
create or replace function public.commit_signing_version(
 p_request_id uuid, p_signer_id uuid, p_expected_path text, p_version_path text
) returns text language plpgsql security definer set search_path = '' as $$
declare
 v_request public.signing_requests%rowtype;
 v_next smallint;
begin
 select * into v_request from public.signing_requests where id = p_request_id for update;
 if not found or v_request.status <> 'pending' or v_request.storage_path <> p_expected_path then
  raise exception 'The document changed. Reopen the request before signing.';
 end if;
 if p_version_path !~ ('^' || p_request_id::text || '/versions/[0-9a-f-]{36}\.pdf$')
 or not exists (select 1 from storage.objects where bucket_id = 'signing-documents' and name = p_version_path) then
  raise exception 'A server-produced signed PDF is required.';
 end if;
 update public.signing_request_signers set status = 'signed', signed_at = now()
 where request_id = p_request_id and signer_id = p_signer_id
 and signer_order = v_request.active_signer_position and status = 'pending';
 if not found then raise exception 'It is not your turn to sign.'; end if;
 select min(signer_order) into v_next from public.signing_request_signers
 where request_id = p_request_id and status = 'pending';
 update public.signing_requests set storage_path = p_version_path,
 active_signer_position = coalesce(v_next, active_signer_position),
 status = case when v_next is null then 'completed' else 'pending' end,
 completed_at = case when v_next is null then now() else null end
 where id = p_request_id;
 return case when v_next is null then 'completed' else 'pending' end;
end;
$$;
revoke all on function public.commit_signing_version(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.commit_signing_version(uuid, uuid, text, text) to service_role;
revoke all on function public.complete_signing_step(uuid) from public, anon, authenticated;
commit;
