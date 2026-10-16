-- +goose Up
-- +goose StatementBegin
-- E5: portal do assinante (isolamento por assinante também no banco) e importação com origem/lote.

create function app_subscriber() returns uuid language sql stable as
  $$ select nullif(current_setting('app.subscriber_id', true), '')::uuid $$;
grant execute on function app_subscriber() to nexo_app;

alter table users add constraint users_subscriber_fk foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id);
alter table users add constraint users_subscriber_role check ((role = 'subscriber') = (subscriber_id is not null));
create unique index users_subscriber_uq on users (subscriber_id) where subscriber_id is not null;

-- Sessão de assinante só enxerga as PRÓPRIAS linhas, mesmo que uma consulta da aplicação esqueça o filtro.
create policy portal_sub on subscribers as restrictive for all using (app_subscriber() is null or id = app_subscriber());
create policy portal_con on contracts as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
create policy portal_inv on invoices as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
create policy portal_res on service_resources as restrictive for all using
  (app_subscriber() is null or exists (select 1 from contracts k where k.id = contract_id and k.subscriber_id = app_subscriber()));
create policy portal_users on users as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
create policy portal_ops on operations as restrictive for all using (app_subscriber() is null);
create policy portal_audit on audit_events as restrictive for select using (app_subscriber() is null);
create policy portal_pay on payments as restrictive for all using
  (app_subscriber() is null or exists (select 1 from invoices i where i.id = invoice_id));
create policy portal_items on invoice_items as restrictive for all using
  (app_subscriber() is null or exists (select 1 from invoices i where i.id = invoice_id));

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null,                      -- origem declarada (ex.: 'csv-intermediario'); identifica external_source
  kind text not null check (kind in ('subscribers','invoices')),
  filename text,
  totals jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table import_rows (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  batch_id uuid not null,
  row_number integer not null,
  external_id text,
  status text not null check (status in ('created','updated','unchanged','error')),
  messages jsonb not null default '[]',
  entity_id uuid,
  foreign key (tenant_id, batch_id) references import_batches (tenant_id, id)
);
alter table import_batches enable row level security;
alter table import_rows enable row level security;
create policy t_ib on import_batches for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ir on import_rows for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert on import_batches, import_rows to nexo_app;
grant usage on all sequences in schema public to nexo_app;

alter table service_resources add column external_source text, add column external_id text;
-- +goose StatementEnd
