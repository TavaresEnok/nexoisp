-- +goose Up
-- +goose StatementBegin
-- A claim and its payment/result commit together; no expiry of financial deduplication.
create table manual_payment_intents (
 tenant_id uuid not null references tenants(id),
 intent_id uuid not null,
 invoice_id uuid not null,
 created_by uuid not null references users(id),
 request_hash text not null,
 result_status text,
 created_at timestamptz not null default now(),
 primary key (tenant_id, intent_id),
 foreign key (tenant_id, invoice_id) references invoices(tenant_id, id)
);
alter table manual_payment_intents enable row level security;
create policy tenant_intents on manual_payment_intents for all
 using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_intents on manual_payment_intents as restrictive for all
 using (app_subscriber() is null);
create policy invoice_intents on manual_payment_intents as restrictive for all
 using (exists (select 1 from invoices i where i.id = invoice_id and i.tenant_id = manual_payment_intents.tenant_id));
grant select, insert, update on manual_payment_intents to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Refuse destructive downgrade; application rollback retains the additive table.
do $$ begin raise exception 'Preserve manual_payment_intents: export and reconcile financial intents before retiring migration 64'; end $$;
-- +goose StatementEnd
