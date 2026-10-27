-- +goose Up
-- +goose StatementBegin
-- Ownership remains in the ACS inventory's operator-assigned tenant tag. This
-- journal binds each command to the visible contract, device and ACS instance;
-- it does not infer ownership from a serial or migrate unproven legacy claims.
create table acs_task_intents (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 contract_id uuid not null,
 intent_id uuid not null,
 device_id text not null check(length(device_id) between 3 and 200),
 server_hash text not null check(server_hash ~ '^[a-f0-9]{64}$'),
 kind text not null check(kind in ('wifi','refresh','reboot')),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 payload_enc text not null,
 state text not null default 'prepared' check(state in ('prepared','uncertain','queued','observed','review','rejected')),
 remote_task_id text,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 last_error text,
 created_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(tenant_id,contract_id,intent_id),
 unique(tenant_id,id),
 foreign key(tenant_id,contract_id) references contracts(tenant_id,id),
 foreign key(created_by) references users(id)
);
alter table acs_task_intents enable row level security;
create policy acs_task_tenant on acs_task_intents for all using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy acs_task_contract on acs_task_intents as restrictive for all using(exists(select 1 from contracts k where k.id=contract_id and k.tenant_id=acs_task_intents.tenant_id));
grant insert on acs_task_intents to nexo_app;
grant select(id,tenant_id,contract_id,intent_id,device_id,server_hash,kind,request_hash,state,remote_task_id,attempts,next_attempt_at,last_error,created_by,created_at,updated_at) on acs_task_intents to nexo_app;
grant update(state,remote_task_id,attempts,next_attempt_at,last_error,updated_at) on acs_task_intents to nexo_app;
create index acs_task_pending on acs_task_intents(tenant_id,next_attempt_at) where state in ('prepared','uncertain','queued');

create function acs_task_payload(p_id uuid) returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select j.payload_enc from public.acs_task_intents j join public.contracts k on k.id=j.contract_id and k.tenant_id=j.tenant_id
 where j.id=p_id and j.tenant_id=public.app_tenant()
 and (public.app_subscriber() is null or k.subscriber_id=public.app_subscriber())
 and (public.app_pops() is null or k.pop_id is null or k.pop_id=any(public.app_pops()))
$$;
revoke all on function acs_task_payload(uuid) from public;
grant execute on function acs_task_payload(uuid) to nexo_app;

create function acs_task_guard() returns trigger language plpgsql as $$
begin
 if row(new.tenant_id,new.contract_id,new.intent_id,new.device_id,new.server_hash,new.kind,new.request_hash,new.created_by,new.created_at)
 is distinct from row(old.tenant_id,old.contract_id,old.intent_id,old.device_id,old.server_hash,old.kind,old.request_hash,old.created_by,old.created_at) then
  raise exception 'ACS intention identity/payload is immutable';
 end if;
 if new.payload_enc is distinct from old.payload_enc and not pg_has_role(current_user,(select relowner from pg_class where oid='public.acs_task_intents'::regclass),'USAGE') then
  raise exception 'only the table owner can reencrypt an ACS envelope';
 end if;
 if new.remote_task_id is distinct from old.remote_task_id and old.remote_task_id is not null then
  raise exception 'ACS remote task identity is immutable';
 end if;
 if new.state is distinct from old.state and not(
  (old.state='prepared' and new.state in ('uncertain','review','rejected')) or
  (old.state='uncertain' and new.state in ('queued','observed','review','rejected')) or
  (old.state='queued' and new.state in ('observed','review','rejected')) or
  (old.state='review' and new.state in ('uncertain','observed'))
 ) then raise exception 'ACS task transition cannot resend an uncertain command';end if;
 new.updated_at=now();return new;
end $$;
revoke all on function acs_task_guard() from public;
create trigger acs_task_guard before update on acs_task_intents for each row execute function acs_task_guard();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve ACS encrypted intentions, IDs and unknown effects; destructive rollback is forbidden';end $$;
-- +goose StatementEnd
