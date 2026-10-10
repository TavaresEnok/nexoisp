-- Estoque por número de série e por responsável: cada unidade de um item "com série" (ONU, roteador) é rastreada individualmente.
alter table stock_items add column serialized boolean not null default false;

create table stock_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  item_id uuid not null,
  serial text not null check (serial ~ '^[A-Za-z0-9._:-]{4,40}$'),
  status text not null default 'in_stock' check (status in ('in_stock','with_tech','installed','defective','written_off')),
  holder_id uuid references users(id),              -- técnico que está com a unidade
  contract_id uuid,                                 -- onde está instalada
  work_order_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, item_id, serial),
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  check ((status = 'with_tech') = (holder_id is not null)),
  check (status <> 'installed' or contract_id is not null)
);
create index stock_units_item on stock_units (item_id, status);
create index stock_units_contract on stock_units (tenant_id, contract_id) where contract_id is not null;

create table stock_unit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  unit_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  event text not null,                              -- received | to_tech | to_stock | installed | returned | defective | written_off
  detail jsonb not null default '{}',
  foreign key (tenant_id, unit_id) references stock_units (tenant_id, id)
);
create index stock_unit_events_unit on stock_unit_events (unit_id, id);

alter table stock_units enable row level security;
alter table stock_unit_events enable row level security;
create policy t_su on stock_units for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_sue on stock_unit_events for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_su on stock_units as restrictive for all using (app_subscriber() is null);
create policy portal_sue on stock_unit_events as restrictive for all using (app_subscriber() is null);
grant select, insert, update on stock_units to nexo_app;
grant select, insert on stock_unit_events to nexo_app;
grant usage on all sequences in schema public to nexo_app;
