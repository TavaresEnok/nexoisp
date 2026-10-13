-- P3 campos personalizados, F5 kit de instalação e técnicos auxiliares, F7 comissão.

-- P3: definição por provedor; o valor fica em jsonb na própria ficha (chave = identificador estável, não o rótulo).
create table custom_fields (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  entity text not null check (entity in ('subscriber','contract')),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  label text not null check (char_length(label) between 2 and 60),
  type text not null check (type in ('text','number','date','boolean','select')),
  options text[],                                         -- só para select
  required boolean not null default false,
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, entity, key),
  check ((type = 'select') = (options is not null and cardinality(options) between 1 and 30))
);
alter table subscribers add column custom jsonb not null default '{}' check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) < 8000);
alter table contracts add column custom jsonb not null default '{}' check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) < 8000);

-- F5: kit = lista de itens de estoque (sem série) lançada de uma vez na OS; auxiliares = outros técnicos na mesma OS.
create table install_kits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table install_kit_items (
  tenant_id uuid not null references tenants(id),
  kit_id uuid not null,
  item_id uuid not null,
  qty integer not null check (qty between 1 and 10000),
  primary key (kit_id, item_id),
  foreign key (tenant_id, kit_id) references install_kits (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id)
);
create table work_order_helpers (
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  user_id uuid not null references users(id),
  added_at timestamptz not null default now(),
  primary key (work_order_id, user_id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id)
);

-- F7: regra de comissão. OS: valor para o responsável e para cada auxiliar, por natureza (nulo = qualquer). Venda: valor ao dono do prospecto ganho.
create table commission_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subject text not null check (subject in ('work_order','sale')),
  os_kind text check (os_kind in ('install','repair','address_change','removal','other')),
  assignee_cents integer not null check (assignee_cents between 0 and 100000000),
  helper_cents integer not null default 0 check (helper_cents between 0 and 100000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (subject = 'work_order' or (os_kind is null and helper_cents = 0))
);
create unique index commission_rules_uq on commission_rules (tenant_id, subject, coalesce(os_kind, '')) where active;

alter table custom_fields enable row level security;
alter table install_kits enable row level security;
alter table install_kit_items enable row level security;
alter table work_order_helpers enable row level security;
alter table commission_rules enable row level security;
create policy t_cf on custom_fields for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ik on install_kits for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_iki on install_kit_items for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_woh on work_order_helpers for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_cr on commission_rules for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cf on custom_fields as restrictive for all using (app_subscriber() is null);
create policy portal_ik on install_kits as restrictive for all using (app_subscriber() is null);
create policy portal_iki on install_kit_items as restrictive for all using (app_subscriber() is null);
create policy portal_woh on work_order_helpers as restrictive for all using (app_subscriber() is null);
create policy portal_cr on commission_rules as restrictive for all using (app_subscriber() is null);
grant select, insert, update on custom_fields, install_kits, commission_rules to nexo_app;
grant select, insert, update, delete on install_kit_items, work_order_helpers to nexo_app;
