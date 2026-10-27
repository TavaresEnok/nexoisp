-- +goose Up
-- +goose StatementBegin
alter table payments add constraint payments_tenant_invoice_identity_uq unique(tenant_id,invoice_id,id);
create table provider_operations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,invoice_id uuid not null,
 financial_connection_id uuid not null,issuance_id uuid not null,
 intent_id uuid not null,kind text not null check(kind in ('cancel','refund')),
 remote_id text not null check(remote_id ~ '^[a-f0-9]{32}$'),
 payment_id uuid,amount_cents integer,
 reason text not null check(length(reason) between 10 and 500),created_by uuid not null,
 state text not null default 'prepared' check(state in ('prepared','uncertain','confirmed','rejected','review')),
 attempts integer not null default 0 check(attempts>=0),next_attempt_at timestamptz not null default now(),
 last_error text check(last_error in ('provider_unknown','provider_unavailable','provider_rejected','provider_conflict','local_failure')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(issuance_id,intent_id),unique(financial_connection_id,remote_id),
 foreign key(tenant_id,invoice_id) references invoices(tenant_id,id),
 foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id),
 foreign key(tenant_id,issuance_id) references provider_issuance(tenant_id,id),
 foreign key(tenant_id,invoice_id,payment_id) references payments(tenant_id,invoice_id,id),
 foreign key(tenant_id,created_by) references users(tenant_id,id),
 check((kind='cancel' and payment_id is null and amount_cents is null) or (kind='refund' and payment_id is not null and amount_cents is not null and amount_cents>0))
);
create unique index provider_one_cancellation on provider_operations(issuance_id) where kind='cancel';
alter table provider_operations enable row level security;
create policy provider_operations_tenant on provider_operations using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy provider_operations_scope on provider_operations as restrictive for all using(app_subscriber() is null and app_pops() is null and exists(select 1 from invoices i where i.id=invoice_id and i.tenant_id=provider_operations.tenant_id));
grant select,insert on provider_operations to nexo_app;
grant update(state,attempts,next_attempt_at,last_error,updated_at) on provider_operations to nexo_app;
create index provider_operations_due on provider_operations(tenant_id,next_attempt_at,id) where state in ('prepared','uncertain');
create function provider_operation_guard() returns trigger language plpgsql as $$
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
   if exists(select 1 from payments where invoice_id=new.invoice_id) then raise exception using errcode='N7301',message='received charge requires refund review, not unpaid cancellation'; end if;
  else
   select * into original from payments where id=new.payment_id and invoice_id=new.invoice_id and tenant_id=new.tenant_id and financial_connection_id=new.financial_connection_id and kind='payment';
   if not found or original.source='manual' or original.method is distinct from 'pix' or original.gateway_payment_id is null or j.product not in ('pix_cob','pix_cobv') then raise exception using errcode='N7301',message='original Pix receipt required'; end if;
   select coalesce(sum(amount_cents),0) into refunded from payments where reversal_of=original.id;
   select coalesce(sum(amount_cents),0) into reserved from provider_operations where payment_id=original.id and state in ('prepared','uncertain','review');
   if new.amount_cents+refunded+reserved>original.amount_cents then raise exception using errcode='N7301',message='refund intention exceeds unreserved received cash'; end if;
  end if;
 end if;
 new.updated_at=now();return new;
end $$;
revoke all on function provider_operation_guard() from public;
create trigger provider_operation_guard before insert or update on provider_operations for each row execute function provider_operation_guard();
alter table invoices add column provider_canceled_at timestamptz;
create function provider_cancel_marker_guard() returns trigger language plpgsql as $$
begin
 if new.provider_canceled_at is distinct from old.provider_canceled_at then
  if old.provider_canceled_at is not null or not exists(select 1 from provider_operations o where o.invoice_id=new.id and o.tenant_id=new.tenant_id and o.kind='cancel' and o.state='confirmed') then
   raise exception using errcode='N7301',message='provider cancellation requires confirmed operation';
  end if;
 end if;return new;
end $$;
revoke all on function provider_cancel_marker_guard() from public;
create trigger provider_cancel_marker_guard before update on invoices for each row execute function provider_cancel_marker_guard();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve provider operation intentions and reconcile uncertain remote mutations before rollback'; end $$;
-- +goose StatementEnd
