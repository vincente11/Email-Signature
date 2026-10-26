-- Run via `supabase db query --linked --project-ref <ref> --file <this file>`.
-- All fixtures and test messages are rolled back; no real users are contacted.
begin;
select set_config('test.chat_a', gen_random_uuid()::text, true),
       set_config('test.chat_b', gen_random_uuid()::text, true),
       set_config('test.chat_c', gen_random_uuid()::text, true),
       set_config('test.message_key', gen_random_uuid()::text, true);
insert into auth.users(id, email, raw_user_meta_data)
select current_setting('test.chat_' || label)::uuid,
       'chat-test-' || current_setting('test.chat_' || label) || '@example.invalid',
       jsonb_build_object('first_name', 'Chat test', 'last_name', label)
from unnest(array['a','b','c']) label;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.chat_a'), 'role', 'authenticated')::text, true);
do $$
declare v_id text; v_retry text;
begin
  v_id := public.send_direct_message(current_setting('test.chat_b')::uuid, 'Hello from chat test', current_setting('test.message_key')::uuid);
  v_retry := public.send_direct_message(current_setting('test.chat_b')::uuid, 'Hello from chat test', current_setting('test.message_key')::uuid);
  if v_id <> v_retry then raise exception 'Retry duplicated the message'; end if;
  perform set_config('test.first_id', v_id, true);
  if (select count(*) from public.list_direct_conversations()) <> 1 then raise exception 'Missing sender conversation'; end if;
  if (select count(*) from public.get_direct_messages(current_setting('test.chat_b')::uuid)) <> 1 then raise exception 'Missing sent message'; end if;
  begin
    perform public.send_direct_message(auth.uid(), 'Self message', gen_random_uuid());
    raise exception 'Self-message accepted';
  exception when others then if sqlerrm = 'Self-message accepted' then raise; end if; end;
  begin
    perform public.send_direct_message(current_setting('test.chat_b')::uuid, ' ', gen_random_uuid());
    raise exception 'Blank message accepted';
  exception when others then if sqlerrm = 'Blank message accepted' then raise; end if; end;
  begin
    perform public.send_direct_message(current_setting('test.chat_b')::uuid, repeat('x', 2001), gen_random_uuid());
    raise exception 'Oversize message accepted';
  exception when others then if sqlerrm = 'Oversize message accepted' then raise; end if; end;
  begin
    insert into public.direct_messages(sender_id, recipient_id, client_message_id, body)
    values (current_setting('test.chat_c')::uuid, current_setting('test.chat_b')::uuid, gen_random_uuid(), 'Spoofed');
    raise exception 'Direct spoof insert accepted';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.chat_c'), 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from public.direct_messages) <> 0 then raise exception 'RLS leaked another conversation'; end if;
  if (select count(*) from public.get_direct_messages(current_setting('test.chat_b')::uuid)) <> 0 then raise exception 'RPC leaked another conversation'; end if;
  if (select count(*) from public.list_direct_conversations()) <> 0 then raise exception 'Inbox leaked another conversation'; end if;
  perform public.mark_direct_messages_read(current_setting('test.chat_a')::uuid, current_setting('test.first_id')::bigint);
end $$;

select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.chat_b'), 'role', 'authenticated')::text, true);
do $$ begin
  if (select unread_count from public.list_direct_conversations() where peer_id = current_setting('test.chat_a')::uuid) <> 1 then raise exception 'Wrong recipient unread count'; end if;
  perform public.mark_direct_messages_read(current_setting('test.chat_a')::uuid, current_setting('test.first_id')::bigint);
  if (select unread_count from public.list_direct_conversations() where peer_id = current_setting('test.chat_a')::uuid) <> 0 then raise exception 'Read state not updated'; end if;
  perform public.send_direct_message(current_setting('test.chat_a')::uuid, 'Reply from chat test', gen_random_uuid());
  if (select count(*) from public.get_direct_messages(current_setting('test.chat_a')::uuid, null, current_setting('test.first_id')::bigint)) <> 1 then raise exception 'Forward pagination failed'; end if;
  if (select count(*) from public.get_direct_messages(current_setting('test.chat_a')::uuid, current_setting('test.first_id')::bigint, null)) <> 0 then raise exception 'History pagination failed'; end if;
  begin
    delete from public.direct_messages where recipient_id = auth.uid();
    raise exception 'Direct delete accepted';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role anon;
do $$ begin
  begin
    perform public.list_direct_conversations();
    raise exception 'Anonymous RPC accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: private conversations, two-way replies, idempotency, validation, pagination, unread state and role restrictions' as result;
rollback;
