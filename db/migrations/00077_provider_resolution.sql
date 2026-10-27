-- +goose Up
-- +goose StatementBegin
lock table invoices,payments,provider_issuance,provider_notices in share row exclusive mode;
create table provider_resolution_evidence(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,issuance_id uuid not null,
 intent_id uuid not null,kind text not null check(kind in ('resolve','reissue')),
 created_by uuid not null,reason text not null check(length(reason) between 10 and 500),
 status text not null check(status in ('active','paid','removed')),charge_id text not null,
 amount_cents integer not null check(amount_cents>0),payments_count integer not null check(payments_count>=0),
 refunds_count integer not null check(refunds_count>=0),review_required boolean not null,
 credential_version_id uuid not null,config_hash text not null check(config_hash ~ '^[a-f0-9]{64}$'),
 snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),observed_at timestamptz not null,
 created_at timestamptz not null default clock_timestamp(),
 unique(tenant_id,id),unique(tenant_id,intent_id),
 foreign key(tenant_id,issuance_id) references provider_issuance(tenant_id,id),
 foreign key(tenant_id,created_by) references users(tenant_id,id)
);
alter table provider_resolution_evidence enable row level security;
create policy resolution_tenant on provider_resolution_evidence using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy resolution_scope on provider_resolution_evidence as restrictive for all using(app_subscriber() is null and app_pops() is null);
grant select,insert on provider_resolution_evidence to nexo_app;
create trigger immutable_provider_resolution before update or delete on provider_resolution_evidence for each row execute function financial_append_only();
alter table provider_issuance add column predecessor_id uuid,add column resolution_id uuid,
 add constraint issuance_predecessor_fk foreign key(tenant_id,predecessor_id) references provider_issuance(tenant_id,id),
 add constraint issuance_resolution_fk foreign key(tenant_id,resolution_id) references provider_resolution_evidence(tenant_id,id),
 add constraint issuance_successor_proof check((predecessor_id is null)=(resolution_id is null));
alter table provider_issuance drop constraint provider_issuance_tenant_id_invoice_id_key;
create unique index provider_issuance_root on provider_issuance(invoice_id) where predecessor_id is null;
create unique index provider_issuance_successor on provider_issuance(predecessor_id) where predecessor_id is not null;

create or replace function provider_issuance_guard() returns trigger language plpgsql as $$
declare c financial_connections; i invoices;
begin
 if TG_OP='UPDATE' then
  if (new.tenant_id,new.invoice_id,new.financial_connection_id,new.intent_key,new.request,new.config_hash,new.credential_version_id,new.product,new.product_options,new.predecessor_id,new.resolution_id)
   is distinct from (old.tenant_id,old.invoice_id,old.financial_connection_id,old.intent_key,old.request,old.config_hash,old.credential_version_id,old.product,old.product_options,old.predecessor_id,old.resolution_id) then raise exception 'issuance identity is immutable'; end if;
  if new.state=old.state then
   if new.charge_id is distinct from old.charge_id then raise exception 'provider response identity is immutable'; end if;
  elsif not ((old.state='prepared' and new.state='uncertain') or (old.state='uncertain' and new.state in ('issued','review')) or (old.state='review' and new.state='uncertain')) then raise exception 'invalid issuance transition'; end if;
 else
  if new.state<>'prepared' or new.charge_id is not null then raise exception 'issuance must start prepared'; end if;
  select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
  if not found or c.provider<>'efi' or c.environment<>'sandbox' or c.status='disabled' then raise exception 'sandbox connection required'; end if;
  select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id;
  if not found or i.company_id is distinct from c.company_id then raise exception 'invoice company mismatch'; end if;
 end if;
 new.updated_at=now();return new;
end $$;
create or replace function provider_issuance_reserve() returns trigger language plpgsql as $$
declare i invoices; c financial_connections; parent provider_issuance; proof provider_resolution_evidence;
begin
 -- Match payment/update order: invoice first, journal second.
 select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
 if not found then raise exception using errcode='42501',message='invoice not visible'; end if;
 select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
 if not found then raise exception using errcode='42501',message='connection not visible'; end if;
 if row(new.request->>'invoice_id',new.request->>'intent_key',new.request#>>'{scope,tenant_id}',new.request#>>'{scope,connection_id}',new.request#>>'{scope,provider}',new.request#>>'{scope,environment}',new.request#>>'{scope,account_ref}',new.request#>>'{money,amount_cents}',new.request#>>'{money,currency}',new.request->>'due_date')
 is distinct from row(i.id::text,new.intent_key,i.tenant_id::text,c.id::text,'efi','sandbox',c.account_ref,i.amount_cents::text,'BRL',i.due_date::text)
 or c.company_id is distinct from i.company_id or c.provider<>'efi' or c.environment<>'sandbox' or c.status='disabled'
 or i.status not in ('open','reconciling') or i.amount_cents<=0 or i.fee_cents<>0 or i.discount_cents<>0
 or exists(select 1 from payments p where p.invoice_id=i.id) then
  raise exception using errcode='N6901',message='invoice is not eligible for a new frozen issuance';
 end if;
 if new.predecessor_id is null then
  if new.resolution_id is not null or i.provider_issuance_id is not null or i.status<>'open' or i.financial_connection_id is not null or i.gateway_charge_id is not null then
   raise exception using errcode='N6901',message='invoice already reserved';
  end if;
 else
  select * into parent from provider_issuance where id=new.predecessor_id and tenant_id=new.tenant_id and invoice_id=new.invoice_id for update;
  if not found or parent.state<>'issued' or i.provider_issuance_id is distinct from parent.id or i.gateway_charge_id is distinct from parent.charge_id or i.financial_connection_id is distinct from parent.financial_connection_id then
   raise exception using errcode='N6901',message='replacement requires current confirmed predecessor';
  end if;
  select * into proof from provider_resolution_evidence where id=new.resolution_id and tenant_id=new.tenant_id and issuance_id=parent.id;
  if not found or proof.kind<>'reissue' or proof.status<>'removed' or proof.payments_count<>0 or proof.refunds_count<>0 or proof.review_required
   or proof.observed_at<clock_timestamp()-interval '2 minutes' or proof.charge_id<>parent.charge_id
   or proof.credential_version_id is distinct from parent.credential_version_id or proof.config_hash<>parent.config_hash
   or new.intent_key<>proof.intent_id::text or new.intent_key=parent.intent_key
   or row(new.financial_connection_id,new.credential_version_id,new.product)
     is distinct from row(parent.financial_connection_id,parent.credential_version_id,parent.product)
   or (new.product<>'bolix' and row(new.config_hash,new.product_options) is distinct from row(parent.config_hash,parent.product_options))
   or (new.product='bolix' and ((new.product_options-'issued_on') is distinct from (parent.product_options-'issued_on')
    or new.product_options->>'issued_on' is distinct from (clock_timestamp() at time zone 'America/Sao_Paulo')::date::text))
   or exists(select 1 from provider_operations where invoice_id=new.invoice_id and state in ('prepared','uncertain','review')) then
   raise exception using errcode='N6901',message='fresh authenticated removal without receipts and unresolved operations required';
  end if;
 end if;
 return new;
end $$;
create or replace function invoice_issuance_guard() returns trigger language plpgsql as $$
declare j provider_issuance;
begin
 if TG_OP='DELETE' then
  if old.provider_issuance_id is not null then raise exception using errcode='N6901',message='provider issuance history must be preserved'; end if;
  return old;
 end if;
 if old.provider_issuance_id is null and new.provider_issuance_id is null then return new; end if;
 -- A successor changes the active pointer only; predecessor and debt stay immutable.
 if old.provider_issuance_id is not null and new.provider_issuance_id is distinct from old.provider_issuance_id then
  select * into j from provider_issuance where id=new.provider_issuance_id and tenant_id=old.tenant_id and invoice_id=old.id;
  if not found or j.predecessor_id is distinct from old.provider_issuance_id or j.resolution_id is null or j.state<>'prepared'
   or row(new.tenant_id,new.contract_id,new.subscriber_id,new.amount_cents,new.due_date,new.fee_cents,new.discount_cents,new.company_id,new.agreement_id)
    is distinct from row(old.tenant_id,old.contract_id,old.subscriber_id,old.amount_cents,old.due_date,old.fee_cents,old.discount_cents,old.company_id,old.agreement_id)
   or new.status<>'open' or new.financial_connection_id is not null or new.gateway is not null or new.gateway_charge_id is not null or new.payment_methods is not null
   or exists(select 1 from payments where invoice_id=old.id) then
    raise exception using errcode='N6901',message='only proven successor may advance reservation';
  end if;
  return new;
 end if;
 -- Ordinary payments after binding must not require journal/account access:
 -- POP-limited operators may see the invoice while RLS hides the journal.
 if old.provider_issuance_id is null then
  select * into j from provider_issuance where id=new.provider_issuance_id and invoice_id=old.id and tenant_id=old.tenant_id;
  if not found then raise exception using errcode='N6901',message='provider issuance reservation not visible'; end if;
 end if;
 -- These are the financial fields sent to the PSP or defining debt ownership.
 if row(new.tenant_id,new.contract_id,new.subscriber_id,new.amount_cents,new.due_date,new.fee_cents,new.discount_cents,new.company_id,new.agreement_id)
 is distinct from row(old.tenant_id,old.contract_id,old.subscriber_id,old.amount_cents,old.due_date,old.fee_cents,old.discount_cents,old.company_id,old.agreement_id)
 or (new.status='canceled' and old.status<>'canceled') then
  raise exception using errcode='N6901',message='provider charge must be reconciled/canceled before changing debt';
 end if;
 if old.gateway_charge_id is null then
  if new.status is distinct from old.status and not (new.status='reconciling'
   and exists(select 1 from provider_issuance current_generation where current_generation.id=old.provider_issuance_id and current_generation.predecessor_id is not null)
   and exists(select 1 from payments p where p.invoice_id=old.id and p.source='reconciliation' and p.gateway_payment_id is not null)) then
    raise exception using errcode='N6901',message='provider issuance result is pending'; end if;
  if row(new.financial_connection_id,new.gateway,new.gateway_charge_id) is distinct from row(old.financial_connection_id,old.gateway,old.gateway_charge_id) then
   select * into j from provider_issuance where id=new.provider_issuance_id and invoice_id=old.id and tenant_id=old.tenant_id;
   if not found then raise exception using errcode='N6901',message='provider issuance reservation not visible'; end if;
   if j.state<>'issued' or new.financial_connection_id is distinct from j.financial_connection_id or new.gateway is distinct from 'efi' or new.gateway_charge_id is distinct from j.charge_id then
    raise exception using errcode='N6901',message='only the confirmed provider response can bind the invoice';
   end if;
  end if;
 else
  if row(new.financial_connection_id,new.gateway,new.gateway_charge_id) is distinct from row(old.financial_connection_id,old.gateway,old.gateway_charge_id) then
   raise exception using errcode='N6901',message='confirmed provider charge identity is immutable';
  end if;
 end if;
 return new;
end $$;
create or replace function provider_issuance_reservation_link() returns trigger language plpgsql as $$
begin
 update invoices set provider_issuance_id=new.id,
 financial_connection_id=case when new.predecessor_id is null then financial_connection_id else null end,
 gateway=case when new.predecessor_id is null then gateway else null end,
 gateway_charge_id=case when new.predecessor_id is null then gateway_charge_id else null end,
 payment_methods=case when new.predecessor_id is null then payment_methods else null end,
 status=case when new.predecessor_id is null then status else 'open' end,
 status_note=case when new.predecessor_id is null then status_note else 'reemissão preparada após remoção comprovada; obrigação preservada' end where tenant_id=new.tenant_id and id=new.invoice_id;
 return new;
end $$;


-- Late authenticated receipts must survive the gap before successor dispatch.
create or replace function provider_issuance_payment_guard() returns trigger language plpgsql as $$
declare i invoices;
begin
 select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
 if not found then raise exception using errcode='42501',message='invoice not visible'; end if;
 if i.provider_issuance_id is not null and i.gateway_charge_id is null and not (
  new.source='reconciliation' and (new.gateway_payment_id is not null or new.provider_refund_id is not null)
  and exists(select 1 from provider_issuance j where j.id=i.provider_issuance_id and j.predecessor_id is not null)
  and exists(select 1 from provider_issuance j where j.invoice_id=i.id and j.state='issued' and j.financial_connection_id=new.financial_connection_id)) then
  raise exception using errcode='N6901',message='payment requires reconciliation of pending provider issuance';
 end if;
 return new;
end $$;

create or replace function financial_binding_guard() returns trigger language plpgsql as $$
declare c financial_connections; i invoices;
begin
 if tg_op='UPDATE' and old.financial_connection_id is not null and
    new.financial_connection_id is distinct from old.financial_connection_id then
  if tg_table_name='invoices' then
   if new.financial_connection_id is null and exists(select 1 from provider_issuance child where child.id=new.provider_issuance_id and child.predecessor_id=old.provider_issuance_id and child.financial_connection_id=old.financial_connection_id and child.state='prepared' and child.resolution_id is not null) then return new; end if;
  end if;
  raise exception 'financial connection is immutable';
 end if;
 if new.financial_connection_id is null then
  if tg_table_name='invoices' then
   if new.gateway_charge_id is not null and (tg_op='INSERT' or new.gateway_charge_id is distinct from old.gateway_charge_id) then raise exception 'financial connection required'; end if;
  elsif tg_table_name='payments' then
   if new.gateway_payment_id is not null then raise exception 'financial connection required'; end if;
  else raise exception 'financial connection required';
  end if;
  return new;
 end if;
 select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
 if not found then raise exception 'financial connection not visible'; end if;
 if tg_table_name='invoices' then
  if c.provider<>new.gateway or c.company_id is distinct from new.company_id then raise exception 'connection company/provider mismatch'; end if;
 elsif tg_table_name='payments' then
  select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id;
  if not found or (i.financial_connection_id is distinct from c.id and not (new.source='reconciliation' and (new.gateway_payment_id is not null or new.provider_refund_id is not null) and exists(select 1 from provider_issuance j where j.tenant_id=new.tenant_id and j.invoice_id=i.id and j.financial_connection_id=c.id and j.state='issued'))) or new.gateway<>c.provider then raise exception 'payment connection mismatch'; end if;
 elsif tg_table_name='gateway_events' then
  if c.provider<>new.gateway then raise exception 'event provider mismatch'; end if;
 end if;
 return new;
end $$;
create or replace function provider_operation_guard() returns trigger language plpgsql as $$
declare j provider_issuance; original payments; reserved bigint; refunded bigint;
begin
 if TG_OP='UPDATE' then
  if row(new.tenant_id,new.invoice_id,new.financial_connection_id,new.issuance_id,new.intent_id,new.kind,new.remote_id,new.payment_id,new.amount_cents,new.reason,new.created_by,new.created_at)
   is distinct from row(old.tenant_id,old.invoice_id,old.financial_connection_id,old.issuance_id,old.intent_id,old.kind,old.remote_id,old.payment_id,old.amount_cents,old.reason,old.created_by,old.created_at) then raise exception using errcode='N7301',message='provider operation identity is immutable'; end if;
  if new.state<>old.state and not ((old.state='prepared' and new.state='uncertain') or (old.state='uncertain' and new.state in ('confirmed','rejected','review')) or (old.state='review' and new.state='uncertain')) then raise exception using errcode='N7301',message='provider operation cannot be resent'; end if;
 else
  if new.state<>'prepared' then raise exception using errcode='N7301',message='operation must start prepared'; end if;
  perform 1 from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
  select * into j from provider_issuance where id=new.issuance_id and tenant_id=new.tenant_id and invoice_id=new.invoice_id and financial_connection_id=new.financial_connection_id;
  if not found or j.state<>'issued' or j.credential_version_id is null then raise exception using errcode='N7301',message='confirmed credentialed issuance required'; end if;
  if new.kind='cancel' then
   if not exists(select 1 from invoices where id=new.invoice_id and provider_issuance_id=new.issuance_id) then raise exception using errcode='N7301',message='cannot cancel superseded issuance';end if;
   if exists(select 1 from payments where invoice_id=new.invoice_id) then raise exception using errcode='N7301',message='received charge requires refund review, not unpaid cancellation'; end if;
  else
   select * into original from payments where id=new.payment_id and invoice_id=new.invoice_id and tenant_id=new.tenant_id and financial_connection_id=new.financial_connection_id and kind='payment';
   if not found or original.source='manual' or original.method is distinct from 'pix' or original.gateway_payment_id is null or j.product not in ('pix_cob','pix_cobv') then raise exception using errcode='N7301',message='original Pix receipt required'; end if;
   if exists(select 1 from provider_issuance other where other.invoice_id=new.invoice_id and other.id<>j.id)
    and not exists(select 1 from audit_events ae where ae.action='finance.provider.receipt' and ae.entity_id=new.invoice_id::text and ae.detail->>'provider_issuance_id'=j.id::text and ae.detail->>'payment_id'=original.gateway_payment_id) then
    raise exception using errcode='N7301',message='receipt generation must be proven before refund';end if;
   select coalesce(sum(amount_cents),0) into refunded from payments where reversal_of=original.id;
   select coalesce(sum(amount_cents),0) into reserved from provider_operations where payment_id=original.id and state in ('prepared','uncertain','review');
   if new.amount_cents+refunded+reserved>original.amount_cents then raise exception using errcode='N7301',message='refund intention exceeds unreserved received cash'; end if;
  end if;
 end if;
 new.updated_at=now();return new;
end $$;

alter table provider_notices add column payload_redacted_at timestamptz;
create function redact_provider_notice_payloads(p_days integer,p_limit integer) returns bigint
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[]; removed bigint;
begin
 if app_tenant() is null or app_subscriber() is not null or app_pops() is not null or p_days is null or p_days<30 or p_limit is null or p_limit not between 1 and 1000 then
  raise exception 'invalid notice retention scope or bounds' using errcode='42501';
 end if;
 select array_agg(id) into ids from (
  select n.id from provider_notices n where n.tenant_id=app_tenant() and n.status='processed' and n.payload_redacted_at is null
   and n.processed_at<clock_timestamp()-make_interval(days=>p_days)
   and exists(select 1 from provider_issuance j where j.tenant_id=n.tenant_id and j.financial_connection_id=n.financial_connection_id and j.charge_id=n.charge_id
    and j.state='issued' and not j.receipt_review and j.receipt_last_error is null and j.receipt_checked_at>=n.processed_at
    and not exists(select 1 from provider_operations o where o.invoice_id=j.invoice_id and o.state in ('prepared','uncertain','review')))
  order by n.created_at,n.id limit p_limit for update of n skip locked) selected;
 if ids is null then return 0;end if;
 update provider_notices set payload='{}'::jsonb,payload_redacted_at=clock_timestamp() where tenant_id=app_tenant() and id=any(ids);
 get diagnostics removed=row_count;
 insert into audit_events(tenant_id,actor_type,actor_id,action,entity_type,detail)
 values(app_tenant(),'system','notice-retention','finance.notice.payload_redact','provider_notice_batch',jsonb_build_object('days',p_days,'ids',ids,'count',removed,'fingerprints_preserved',true));
 return removed;
end $$;
revoke all on function redact_provider_notice_payloads(integer,integer) from public;
grant execute on function redact_provider_notice_payloads(integer,integer) to nexo_app;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve charge succession, authenticated evidence and notification tombstones; destructive rollback refused';end $$;
-- +goose StatementEnd
