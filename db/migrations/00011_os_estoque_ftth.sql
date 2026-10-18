-- +goose Up
-- +goose StatementBegin
-- Expansão 3 (pós-MVP): ordens de serviço, estoque e inventário FTTH (caixas e portas).

-- Numeração sequencial por provedor (OS, protocolos de atendimento).
create table tenant_counters (
  tenant_id uuid not null references tenants(id),
  key text not null,
  value bigint not null default 0,
  primary key (tenant_id, key)
);

create table work_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number bigint not null,
  kind text not null check (kind in ('install','repair','address_change','removal','other')),
  status text not null default 'open' check (status in ('open','scheduled','in_progress','done','canceled')),
  subscriber_id uuid not null,
  contract_id uuid,
  assignee_id uuid references users(id),
  scheduled_for timestamptz,
  description text not null,
  resolution text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check ((status in ('done','canceled')) = (finished_at is not null)),
  check (status <> 'done' or resolution is not null)
);
create index work_orders_open on work_orders (tenant_id, scheduled_for) where status in ('open','scheduled','in_progress');
create index work_orders_subscriber on work_orders (tenant_id, subscriber_id, created_at desc);

create table work_order_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  event text not null,                              -- created | status | assigned | scheduled | note | material
  detail jsonb not null default '{}',
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id)
);
create index work_order_events_wo on work_order_events (work_order_id, id);

create table stock_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  sku text,
  unit text not null default 'un' check (unit ~ '^[a-zA-Z]{1,6}$'),
  min_qty integer not null default 0 check (min_qty >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create unique index stock_items_sku_uq on stock_items (tenant_id, sku) where sku is not null;

-- Razão do estoque: o saldo é a soma dos movimentos. Movimento não é alterado nem apagado; corrige-se com outro movimento.
create table stock_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  item_id uuid not null,
  qty integer not null check (qty <> 0),            -- positivo entra, negativo sai
  kind text not null check (kind in ('in','out','adjust')),
  work_order_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  check ((kind = 'in' and qty > 0) or (kind = 'out' and qty < 0) or kind = 'adjust')
);
create index stock_movements_item on stock_movements (item_id, id desc);
create index stock_movements_wo on stock_movements (work_order_id) where work_order_id is not null;

-- Inventário FTTH: caixa de atendimento/emenda com N portas; opcionalmente ligada à porta PON de uma OLT e a uma caixa anterior.
create table ftth_boxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  kind text not null check (kind in ('cto','ceo')),
  ports integer not null check (ports between 1 and 144),
  parent_id uuid,
  device_id uuid,                                   -- OLT
  pon_port text check (pon_port ~ '^[0-9]{1,3}(/[0-9]{1,3}){0,3}$'),
  address text,
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, parent_id) references ftth_boxes (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id),
  check (parent_id is null or parent_id <> id)
);

-- Porta ocupada: um contrato usa no máximo uma porta; uma porta atende no máximo um contrato.
create table ftth_drops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  box_id uuid not null,
  port integer not null check (port >= 1),
  contract_id uuid,
  note text,
  created_at timestamptz not null default now(),
  unique (box_id, port),
  foreign key (tenant_id, box_id) references ftth_boxes (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check (contract_id is not null or note is not null)
);
create unique index ftth_drops_contract_uq on ftth_drops (tenant_id, contract_id) where contract_id is not null;

alter table tenant_counters enable row level security;
alter table work_orders enable row level security;
alter table work_order_events enable row level security;
alter table stock_items enable row level security;
alter table stock_movements enable row level security;
alter table ftth_boxes enable row level security;
alter table ftth_drops enable row level security;
create policy t_cnt on tenant_counters for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_wo on work_orders for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_woe on work_order_events for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_si on stock_items for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_sm on stock_movements for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_fb on ftth_boxes for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_fd on ftth_drops for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_wo on work_orders as restrictive for all using (app_subscriber() is null);
create policy portal_woe on work_order_events as restrictive for all using (app_subscriber() is null);
create policy portal_si on stock_items as restrictive for all using (app_subscriber() is null);
create policy portal_sm on stock_movements as restrictive for all using (app_subscriber() is null);
create policy portal_fb on ftth_boxes as restrictive for all using (app_subscriber() is null);
create policy portal_fd on ftth_drops as restrictive for all using (app_subscriber() is null);
grant select, insert, update on tenant_counters, work_orders, stock_items to nexo_app;
grant select, insert on work_order_events, stock_movements to nexo_app;
grant select, insert, update, delete on ftth_boxes, ftth_drops to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
