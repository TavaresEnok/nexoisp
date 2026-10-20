-- +goose Up
-- +goose StatementBegin
-- Estoque: depósitos adicionais, fornecedores e pedidos de compra.
-- Movimentos sem depósito pertencem ao depósito principal (inclusive os
-- anteriores a esta migração); o saldo total continua sendo a soma de tudo.
create table stock_warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  address text not null default '' check (char_length(address) <= 200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 120),
  document text check (document ~ '^[0-9]{11}$|^[0-9]{14}$'),
  email text check (char_length(email) <= 120),
  phone text check (char_length(phone) <= 30),
  notes text not null default '' check (char_length(notes) <= 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number integer not null,
  supplier_id uuid not null,
  warehouse_id uuid,
  status text not null default 'draft' check (status in ('draft', 'ordered', 'received', 'canceled')),
  expected_at date,
  note text not null default '' check (char_length(note) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  received_by uuid references users(id),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id),
  foreign key (tenant_id, warehouse_id) references stock_warehouses (tenant_id, id)
);
create table purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  order_id uuid not null,
  item_id uuid not null,
  qty integer not null check (qty between 1 and 1000000),
  unit_cost_cents integer not null check (unit_cost_cents between 0 and 100000000),
  unique (order_id, item_id),
  foreign key (tenant_id, order_id) references purchase_orders (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id)
);
alter table stock_movements add column warehouse_id uuid, add column purchase_order_id uuid;
alter table stock_movements add constraint stock_movements_warehouse_fk foreign key (tenant_id, warehouse_id) references stock_warehouses (tenant_id, id);
alter table stock_movements add constraint stock_movements_purchase_fk foreign key (tenant_id, purchase_order_id) references purchase_orders (tenant_id, id);
-- transferência entre depósitos: par de movimentos com a mesma quantidade em sinais opostos
alter table stock_movements drop constraint stock_movements_kind_check;
alter table stock_movements drop constraint stock_movements_check;
alter table stock_movements add constraint stock_movements_kind_check check (kind in ('in', 'out', 'adjust', 'transfer'));
alter table stock_movements add constraint stock_movements_check check ((kind = 'in' and qty > 0) or (kind = 'out' and qty < 0) or kind in ('adjust', 'transfer'));
create index stock_movements_warehouse on stock_movements (item_id, warehouse_id);

alter table stock_warehouses enable row level security;
alter table suppliers enable row level security;
alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
create policy t_stock_warehouses on stock_warehouses for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_suppliers on suppliers for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_purchase_orders on purchase_orders for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_purchase_order_items on purchase_order_items for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_stock_warehouses on stock_warehouses as restrictive for all using (app_subscriber() is null);
create policy portal_suppliers on suppliers as restrictive for all using (app_subscriber() is null);
create policy portal_purchase_orders on purchase_orders as restrictive for all using (app_subscriber() is null);
create policy portal_purchase_order_items on purchase_order_items as restrictive for all using (app_subscriber() is null);
grant select, insert, update on stock_warehouses, suppliers, purchase_orders to nexo_app;
grant select, insert, update, delete on purchase_order_items to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
alter table stock_movements drop constraint stock_movements_check;
alter table stock_movements drop constraint stock_movements_kind_check;
delete from stock_movements where kind = 'transfer';
alter table stock_movements add constraint stock_movements_kind_check check (kind in ('in', 'out', 'adjust'));
alter table stock_movements add constraint stock_movements_check check ((kind = 'in' and qty > 0) or (kind = 'out' and qty < 0) or kind = 'adjust');
drop index stock_movements_warehouse;
alter table stock_movements drop constraint stock_movements_purchase_fk, drop constraint stock_movements_warehouse_fk;
alter table stock_movements drop column purchase_order_id, drop column warehouse_id;
drop table purchase_order_items;
drop table purchase_orders;
drop table suppliers;
drop table stock_warehouses;
-- +goose StatementEnd
