-- +goose Up
-- +goose StatementBegin
create table provider_notices (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 financial_connection_id uuid not null,
 payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),
 charge_id text not null check(length(charge_id) between 1 and 256),
 payment_id text not null check(length(payment_id) between 1 and 256),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 status text not null check(status in ('unmatched','pending','processed','review')),
 created_at timestamptz not null default now(),
 processed_at timestamptz,
 unique(financial_connection_id,payload_hash),
 foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id)
);
alter table provider_notices enable row level security;
create policy notice_tenant on provider_notices using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy notice_scope on provider_notices as restrictive for all using(app_subscriber() is null and app_pops() is null);
grant select,insert on provider_notices to nexo_app;
grant update(status,processed_at) on provider_notices to nexo_app;
create index provider_notices_pending on provider_notices(tenant_id,financial_connection_id,charge_id) where status in ('unmatched','pending');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve authenticated provider inbox; reconcile unmatched/pending notices before rollback'; end $$;
-- +goose StatementEnd
