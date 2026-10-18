-- +goose Up
-- +goose StatementBegin
-- Produtos adicionais recorrentes (combo = plano + adicionais do contrato): TV, telefonia, IP fixo, roteador em comodato etc.
-- Entram na mensalidade como linhas próprias. O desconto do contrato continua valendo só sobre o plano.
create table addon_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  price_cents integer not null check (price_cents between 0 and 100000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table contract_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  product_id uuid not null,
  description text not null,                                   -- nome do produto no momento da contratação (a fatura mantém o texto)
  quantity integer not null default 1 check (quantity between 1 and 99),
  unit_price_cents integer not null check (unit_price_cents between 0 and 100000000),   -- preço combinado, congelado na contratação
  from_competence date not null check (from_competence = date_trunc('month', from_competence)::date),
  ended_competence date check (ended_competence is null or (ended_competence = date_trunc('month', ended_competence)::date and ended_competence >= from_competence)),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, product_id) references addon_products (tenant_id, id)
);
create index contract_addons_contract on contract_addons (contract_id);
alter table addon_products enable row level security;
alter table contract_addons enable row level security;
create policy t_addon_products on addon_products for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_contract_addons on contract_addons for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_addon_products on addon_products as restrictive for all using (app_subscriber() is null);
create policy portal_contract_addons on contract_addons as restrictive for all using (app_subscriber() is null);
grant select, insert, update on addon_products, contract_addons to nexo_app;
-- +goose StatementEnd
