-- +goose Up
-- +goose StatementBegin
-- Preserve legacy accounting and operations. Device identity is backfilled only
-- where the current source address and tenant prove an unambiguous NAS mapping.
alter table radius_nas add column accounting_epoch_at timestamptz;
alter table radius_acct add column nas_device_id uuid;
alter table radius_acct add column source_unique_id text;
alter table radius_acct add column changed_at timestamptz not null default clock_timestamp();
alter table radius_acct add column framed_ipv6_address inet check(framed_ipv6_address is null or family(framed_ipv6_address)=6);
alter table radius_acct add column framed_ipv6_prefix cidr check(framed_ipv6_prefix is null or family(framed_ipv6_prefix)=6);
alter table radius_acct add column delegated_ipv6_prefix cidr check(delegated_ipv6_prefix is null or family(delegated_ipv6_prefix)=6);
alter table radius_acct add constraint radius_acct_nas_device foreign key(tenant_id,nas_device_id) references devices(tenant_id,id);
-- Metadata backfill is not a new NAS packet. Preserve the original seen_at.
create or replace function radius_acct_touch() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 new.changed_at=clock_timestamp();
 if tg_op='UPDATE' then
  if current_setting('nexo.accounting_ingest',true)='on' and current_setting('nexo.accounting_metadata_only',true) is distinct from 'on' then new.seen_at=clock_timestamp();
  else new.seen_at=old.seen_at;end if;
 end if;
 return new;
end $$;
select set_config('nexo.accounting_metadata_only','on',true);
update radius_acct a set nas_device_id=n.device_id,source_unique_id=a.unique_id from radius_nas n where n.tenant_id=a.tenant_id and n.nas_ip=a.nas_ip;
select set_config('nexo.accounting_metadata_only','off',true);
create index radius_acct_generation on radius_acct(tenant_id,nas_device_id,username,session_id,started_at desc);

create table radius_accounting_events (
 id bigint generated always as identity primary key,
 tenant_id uuid not null references tenants(id),
 nas_device_id uuid,
 source_ip inet not null,
 event_key text not null unique,
 kind text not null,
 session_id text not null,
 username text not null,
 event_at timestamptz,
 data jsonb not null,
 status text not null check(status in ('received','applied','ignored','quarantine')),
 reason text,
 accounting_id bigint,
 deliveries bigint not null default 1,
 received_at timestamptz not null default clock_timestamp(),
 last_received_at timestamptz not null default clock_timestamp(),
 reprocesses integer not null default 0,
 reviewed_by uuid,
 review_reason text,
 reviewed_at timestamptz
);
create index radius_events_review on radius_accounting_events(tenant_id,id desc) where status='quarantine';
create index radius_events_retention on radius_accounting_events(tenant_id,received_at) where status in ('applied','ignored');
alter table radius_accounting_events enable row level security;
create policy radius_events_tenant on radius_accounting_events for select to nexo_app using(tenant_id=app_tenant());
create policy radius_events_full_scope on radius_accounting_events as restrictive for select to nexo_app using(app_subscriber() is null and app_pops() is null);
grant select on radius_accounting_events to nexo_app;
grant usage,select on sequence radius_accounting_events_id_seq to nexo_app;

create function radius_record_accounting(p_tenant uuid,p_source inet,p_event jsonb,p_retry_id bigint) returns text
language plpgsql security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare
 device uuid; epoch timestamptz; event_time timestamptz; start_time timestamptz;
 event_kind text; sid text; usr text; uid text; seconds bigint; incoming bigint; outgoing bigint;
 v6 inet; prefix cidr; delegated cidr; ipv4 inet;
 clean jsonb; event_hash text; event_id bigint; why text; matched public.radius_acct%rowtype;
 candidates bigint; needs_review boolean:=false;
 received timestamptz:=clock_timestamp();prior public.radius_accounting_events%rowtype;
begin
 if p_tenant is null or p_source is null or p_event is null or jsonb_typeof(p_event)<>'object' or octet_length(p_event::text)>8192 then
  raise exception 'invalid accounting envelope' using errcode='22023';
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into clean from jsonb_each(p_event)
 where key=any(array['kind','timestamp','received','delay','unique_id','session_id','username','seconds','input','output','framed_ip','framed_ipv6_address','framed_ipv6_prefix','delegated_ipv6_prefix','port','calling','called','cause']);
 event_kind=lower(replace(coalesce(clean->>'kind',''),'-','_'));
 sid=coalesce(clean->>'session_id','');usr=coalesce(clean->>'username','');uid=coalesce(clean->>'unique_id','');
 if event_kind not in ('start','interim_update','stop','accounting_on','accounting_off') then why='unsupported_event';end if;
 if length(sid)>253 or length(usr)>253 or length(uid)>128 then why='invalid_identity';end if;
 if event_kind in ('start','interim_update','stop') and (sid='' or usr='' or uid='') then why='missing_identity';end if;
 begin
  if nullif(clean->>'timestamp','') is not null and (clean->>'timestamp')::numeric>0 then
   event_time=to_timestamp((clean->>'timestamp')::double precision);
  else
   event_time=to_timestamp(coalesce(nullif(clean->>'received','')::double precision,extract(epoch from clock_timestamp())))-make_interval(secs=>coalesce(nullif(clean->>'delay','')::double precision,0));
  end if;
  if event_time>clock_timestamp()+interval '5 minutes' or event_time<clock_timestamp()-interval '35 days' then why='event_clock_outside_window';end if;
  seconds=nullif(clean->>'seconds','')::bigint;
  if event_kind='start' then seconds=0;end if;
  incoming=coalesce(nullif(clean->>'input','')::bigint,0);outgoing=coalesce(nullif(clean->>'output','')::bigint,0);
  if seconds<0 or seconds>315360000 or incoming<0 or outgoing<0 then why='invalid_counters';end if;
  ipv4=nullif(clean->>'framed_ip','')::inet;
  if ipv4 is not null and family(ipv4)<>4 then why='invalid_ipv4';end if;
  v6=nullif(clean->>'framed_ipv6_address','')::inet;
  prefix=network(nullif(clean->>'framed_ipv6_prefix','')::inet)::cidr;
  delegated=network(nullif(clean->>'delegated_ipv6_prefix','')::inet)::cidr;
  if (v6 is not null and family(v6)<>6) or (prefix is not null and family(prefix)<>6) or (delegated is not null and family(delegated)<>6) then why='invalid_ipv6';end if;
 exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then why='invalid_values';
 end;
 select n.device_id into device from public.radius_nas n where n.tenant_id=p_tenant and n.nas_ip=p_source for key share;
 if device is null then why='unregistered_nas';else
  -- Parallel sessions share the NAS barrier; reboot gets the exclusive barrier.
  if event_kind in ('accounting_on','accounting_off') then perform pg_advisory_xact_lock(hashtextextended('radius-nas:'||device::text,7601));
  else
   perform pg_advisory_xact_lock_shared(hashtextextended('radius-nas:'||device::text,7601));
   perform pg_advisory_xact_lock(hashtextextended('radius-session:'||device::text||':'||usr||':'||sid,7602));
  end if;
  select accounting_epoch_at into epoch from public.radius_nas where device_id=device;
 end if;
 -- Receiver timing does not create another event when a NAS timestamp exists.
 event_hash=encode(public.digest(convert_to(p_tenant::text||'|'||host(p_source)||'|'||(clean-array['received','delay'])::text||'|'||coalesce(event_time::text,''),'UTF8'),'sha256'),'hex');
 if p_retry_id is not null then
  select * into prior from public.radius_accounting_events where id=p_retry_id and tenant_id=p_tenant and event_key=event_hash for update;
  if prior.id is null or prior.nas_device_id is null or prior.nas_device_id is distinct from device then
   raise exception 'accounting replay requires unchanged, proven NAS identity' using errcode='42501';
  end if;
  if prior.status<>'quarantine' then return 'already_processed';end if;
  event_id=prior.id;received=prior.last_received_at;
  update public.radius_accounting_events set reprocesses=reprocesses+1 where id=event_id;
 else
  insert into public.radius_accounting_events(tenant_id,nas_device_id,source_ip,event_key,kind,session_id,username,event_at,data,status,reason)
  values(p_tenant,device,p_source,event_hash,event_kind,sid,usr,event_time,clean,'received',why)
  on conflict(event_key) do nothing returning id into event_id;
  if event_id is null then
   update public.radius_accounting_events set deliveries=deliveries+1,last_received_at=clock_timestamp() where event_key=event_hash;
   return 'duplicate';
  end if;
 end if;
 if why is not null then
  update public.radius_accounting_events set status='quarantine',reason=why where id=event_id;return 'quarantine';
 end if;
 if p_retry_id is null then update public.radius_nas set last_packet_at=clock_timestamp() where device_id=device;end if;
 if event_kind in ('accounting_on','accounting_off') then
  if epoch is not null and event_time<=epoch then
   update public.radius_accounting_events set status='ignored',reason='older_or_duplicate_nas_epoch' where id=event_id;return 'ignored';
  end if;
  update public.radius_nas set accounting_epoch_at=event_time where device_id=device;
  update public.radius_acct set stopped_at=event_time,updated_at=greatest(updated_at,event_time),
   session_seconds=greatest(session_seconds,greatest(0,extract(epoch from event_time-started_at)::bigint)),terminate_cause='NAS-Reboot'
   where tenant_id=p_tenant and nas_device_id=device and stopped_at is null and started_at<=event_time and updated_at<=event_time;
  update public.radius_accounting_events set status='applied' where id=event_id;return 'applied';
 end if;
 start_time=case when seconds is not null then event_time-make_interval(secs=>seconds::double precision) end;
 -- Event time plus NAS uptime identifies a generation even if a reboot reuses
 -- Acct-Session-Id/Acct-Unique-Session-Id, or source IP changes to a tunnel.
 select count(*) into candidates from public.radius_acct a where a.tenant_id=p_tenant and a.nas_device_id=device and a.username=usr and a.session_id=sid
 and a.started_at<=event_time
 and ((start_time is not null and abs(extract(epoch from a.started_at-start_time))<=5)
      or (start_time is null and a.source_unique_id=uid and a.stopped_at is null))
 and not(event_kind='start' and a.stopped_at is not null and event_time>a.stopped_at);
 if candidates>1 then needs_review=true;why='ambiguous_generation';
 elsif candidates=1 then
  select a.* into matched from public.radius_acct a where a.tenant_id=p_tenant and a.nas_device_id=device and a.username=usr and a.session_id=sid
   and a.started_at<=event_time
   and ((start_time is not null and abs(extract(epoch from a.started_at-start_time))<=5) or (start_time is null and a.source_unique_id=uid and a.stopped_at is null))
   and not(event_kind='start' and a.stopped_at is not null and event_time>a.stopped_at) for update;
 else
  if start_time is null then needs_review=true;why='missing_session_time';
  elsif exists(select 1 from public.radius_acct a where a.tenant_id=p_tenant and a.nas_device_id=device and a.username=usr and a.session_id=sid and a.stopped_at is null) then
   needs_review=true;why=case when event_kind='start' then 'overlapping_generation' else 'session_clock_divergence' end;
  end if;
 end if;
 if needs_review then update public.radius_accounting_events set status='quarantine',reason=why where id=event_id;return 'quarantine';end if;
 if matched.id is not null then
  if event_time<matched.updated_at or (matched.stopped_at is not null and event_kind<>'stop') then
   update public.radius_accounting_events set status='ignored',reason='stale_or_closed',accounting_id=matched.id where id=event_id;return 'ignored';
  end if;
  -- A new Start cannot clear a prior Stop. Counters never regress, even if a
  -- NAS sends another packet with the same timestamp or resets counters.
  update public.radius_acct set updated_at=greatest(updated_at,event_time),session_seconds=greatest(session_seconds,coalesce(seconds,session_seconds)),
   bytes_in=greatest(bytes_in,incoming),bytes_out=greatest(bytes_out,outgoing),
   stopped_at=case when event_kind='stop' then coalesce(stopped_at,event_time) else stopped_at end,
   terminate_cause=case when event_kind='stop' then coalesce(nullif(clean->>'cause',''),terminate_cause) else terminate_cause end,
   framed_ip=coalesce(host(ipv4),framed_ip),framed_ipv6_address=coalesce(v6,framed_ipv6_address),framed_ipv6_prefix=coalesce(prefix,framed_ipv6_prefix),delegated_ipv6_prefix=coalesce(delegated,delegated_ipv6_prefix)
   where id=matched.id;
 else
  insert into public.radius_acct(tenant_id,nas_device_id,source_unique_id,unique_id,session_id,username,nas_ip,nas_port,started_at,updated_at,stopped_at,session_seconds,bytes_in,bytes_out,calling_station,called_station,framed_ip,framed_ipv6_address,framed_ipv6_prefix,delegated_ipv6_prefix,terminate_cause,seen_at)
   values(p_tenant,device,uid,'v2:'||encode(public.digest(convert_to(p_tenant::text||':'||device::text||':'||usr||':'||sid||':'||start_time::text,'UTF8'),'sha256'),'hex'),sid,usr,p_source,nullif(clean->>'port',''),start_time,event_time,
    case when event_kind='stop' then event_time when epoch is not null and start_time<epoch then epoch end,
    coalesce(seconds,0),incoming,outgoing,nullif(clean->>'calling',''),nullif(clean->>'called',''),host(ipv4),v6,prefix,delegated,
    case when epoch is not null and start_time<epoch then 'NAS-Reboot' else nullif(clean->>'cause','') end,received) returning * into matched;
 end if;
 update public.radius_accounting_events set status='applied',accounting_id=matched.id where id=event_id;return 'applied';
end $$;
revoke all on function radius_record_accounting(uuid,inet,jsonb,bigint) from public;
-- The transport role can ingest only, never bypass administrative review.
create function radius_record_accounting(p_tenant uuid,p_source inet,p_event jsonb) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_flag text;result text;
begin
 old_flag=current_setting('nexo.accounting_ingest',true);
 perform set_config('nexo.accounting_ingest','on',true);
 result=public.radius_record_accounting(p_tenant,p_source,p_event,null::bigint);
 perform set_config('nexo.accounting_ingest',coalesce(old_flag,''),true);
 return result;
end $$;
revoke all on function radius_record_accounting(uuid,inet,jsonb) from public;
grant execute on function radius_record_accounting(uuid,inet,jsonb) to nexo_radius;

create function radius_retry_accounting(p_id bigint,p_actor uuid,p_reason text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare item public.radius_accounting_events%rowtype;result text;old_flag text;
begin
 if public.app_tenant() is null or public.app_subscriber() is not null or public.app_pops() is not null or p_reason is null or length(trim(p_reason)) not between 10 and 500 then
  raise exception 'accounting review requires full tenant scope and a reason' using errcode='42501';
 end if;
 if not exists(select 1 from public.users where id=p_actor and tenant_id=public.app_tenant() and active) then raise exception 'invalid accounting actor' using errcode='42501';end if;
 select * into item from public.radius_accounting_events where id=p_id and tenant_id=public.app_tenant();
 if item.id is null then raise exception 'accounting event not available' using errcode='42501';end if;
 if item.status<>'quarantine' then return 'already_processed';end if;
 old_flag=current_setting('nexo.accounting_metadata_only',true);
 perform set_config('nexo.accounting_metadata_only','on',true);
 result=public.radius_record_accounting(item.tenant_id,item.source_ip,item.data,item.id);
 perform set_config('nexo.accounting_metadata_only',coalesce(old_flag,''),true);
 update public.radius_accounting_events set reviewed_by=p_actor,review_reason=trim(p_reason),reviewed_at=clock_timestamp() where id=item.id;
 insert into public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,detail)
 values(item.tenant_id,'user',p_actor::text,'radius.accounting.reconcile','radius_accounting_event',item.id::text,jsonb_build_object('reason',trim(p_reason),'prior_reason',item.reason,'result',result,'sends_to_nas',false));
 return result;
end $$;
revoke all on function radius_retry_accounting(bigint,uuid,text) from public;
grant execute on function radius_retry_accounting(bigint,uuid,text) to nexo_app;
-- Administrative disposition changes evidence workflow only, never sessions,
-- network operation states or authentication policy.
create function radius_dismiss_accounting(p_id bigint,p_actor uuid,p_reason text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare item public.radius_accounting_events%rowtype;
begin
 if public.app_tenant() is null or public.app_subscriber() is not null or public.app_pops() is not null or p_reason is null or length(trim(p_reason)) not between 10 and 500 then
  raise exception 'accounting disposition requires full tenant scope and a reason' using errcode='42501';
 end if;
 if not exists(select 1 from public.users where id=p_actor and tenant_id=public.app_tenant() and active) then raise exception 'invalid accounting actor' using errcode='42501';end if;
 select * into item from public.radius_accounting_events where id=p_id and tenant_id=public.app_tenant() for update;
 if item.id is null then raise exception 'accounting event not available' using errcode='42501';end if;
 if item.status<>'quarantine' then return 'already_processed';end if;
 update public.radius_accounting_events set status='ignored',reviewed_by=p_actor,review_reason=trim(p_reason),reviewed_at=clock_timestamp() where id=item.id;
 insert into public.audit_events(tenant_id,actor_type,actor_id,action,entity_type,entity_id,detail)
 values(item.tenant_id,'user',p_actor::text,'radius.accounting.dismiss','radius_accounting_event',item.id::text,jsonb_build_object('reason',trim(p_reason),'original_reason',item.reason,'changes_sessions',false,'sends_to_nas',false));
 return 'ignored';
end $$;
revoke all on function radius_dismiss_accounting(bigint,uuid,text) from public;
grant execute on function radius_dismiss_accounting(bigint,uuid,text) to nexo_app;

create function radius_purge_accounting_events(p_days integer,p_limit integer) returns bigint
language plpgsql security definer set search_path=pg_catalog,public as $$
declare removed bigint;
begin
 if app_tenant() is null or app_subscriber() is not null or app_pops() is not null or p_days is null or p_days<35 or p_limit is null or p_limit not between 1 and 5000 then
  raise exception 'invalid accounting retention scope or bounds' using errcode='42501';
 end if;
 delete from radius_accounting_events where id in (select id from radius_accounting_events where tenant_id=app_tenant() and status in ('applied','ignored') and last_received_at<now()-make_interval(days=>p_days) order by id limit p_limit);
 get diagnostics removed=row_count;return removed;
end $$;
revoke all on function radius_purge_accounting_events(integer,integer) from public;
grant execute on function radius_purge_accounting_events(integer,integer) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve accounting generations, event evidence, NAS epoch and IPv6; destructive rollback is forbidden';end $$;
-- +goose StatementEnd
