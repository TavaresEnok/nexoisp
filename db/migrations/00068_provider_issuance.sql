-- +goose Up
-- +goose StatementBegin
-- Additive journal only. No existing invoice/payment is changed and no adapter
-- is enabled. One intention per invoice until explicit cancellation/reissue rules.
create table provider_issuance (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 invoice_id uuid not null,
 financial_connection_id uuid not null,
 intent_key text not null check(length(intent_key) between 1 and 256),
 request jsonb not null check(jsonb_typeof(request)='object'),
 config_hash text not null check(config_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'prepared' check(state in ('prepared','uncertain','issued','review')),
 charge_id text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(tenant_id,invoice_id),
 unique(financial_connection_id,intent_key),
 foreign key(tenant_id,invoice_id) references invoices(tenant_id,id),
 foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id),
 check((state='issued')=(charge_id is not null))
);
alter table provider_issuance enable row level security;
create policy provider_issuance_tenant on provider_issuance using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy provider_issuance_scope on provider_issuance as restrictive for all
 using(app_subscriber() is null and app_pops() is null and exists(select 1 from invoices i where i.id=invoice_id and i.tenant_id=provider_issuance.tenant_id));
grant select,insert on provider_issuance to nexo_app;
grant update(state,charge_id,updated_at) on provider_issuance to nexo_app;
create function provider_issuance_guard() returns trigger language plpgsql as $$
declare c financial_connections; i invoices;
begin
 if TG_OP='UPDATE' then
  if (new.tenant_id,new.invoice_id,new.financial_connection_id,new.intent_key,new.request,new.config_hash) is distinct from
     (old.tenant_id,old.invoice_id,old.financial_connection_id,old.intent_key,old.request,old.config_hash) then raise exception 'issuance identity is immutable'; end if;
  if not ((old.state='prepared' and new.state='uncertain') or (old.state='uncertain' and new.state in ('issued','review'))) then raise exception 'invalid issuance transition'; end if;
 else
  if new.state<>'prepared' or new.charge_id is not null then raise exception 'issuance must start prepared'; end if;
  select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
  if not found or c.provider<>'efi' or c.environment<>'sandbox' or c.status='disabled' then raise exception 'sandbox connection required'; end if;
  select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id;
  if not found or i.company_id is distinct from c.company_id then raise exception 'invoice company mismatch'; end if;
 end if;
 new.updated_at=now();return new;
end $$;
revoke all on function provider_issuance_guard() from public;
create trigger provider_issuance_guard before insert or update on provider_issuance for each row execute function provider_issuance_guard();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve provider issuance journal: uncertain writes require reconciliation, not destructive downgrade'; end $$;
-- +goose StatementEnd
