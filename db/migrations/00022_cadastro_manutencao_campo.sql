-- +goose Up
-- +goose StatementBegin
-- Itens do comparativo com o SGP (docs/07) que são só cadastro e operação: dados da pessoa, etiquetas de contrato,
-- aviso de manutenção ao assinante, checklist da OS e modalidade do equipamento instalado (comodato ou venda).

-- ---- dados do assinante ----
alter table subscribers
  add column birth_date date,
  add column rg text check (rg ~ '^[0-9A-Za-z.\- /]{3,20}$'),
  add column rg_issuer text check (char_length(rg_issuer) <= 20),
  add column mother_name text check (char_length(mother_name) <= 200),
  add column trade_name text check (char_length(trade_name) <= 200);   -- nome fantasia (pessoa jurídica)

-- ---- etiquetas de contrato ----
create table tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 40),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table contract_tags (
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  tag_id uuid not null,
  primary key (contract_id, tag_id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, tag_id) references tags (tenant_id, id) on delete cascade
);
create index contract_tags_tag on contract_tags (tenant_id, tag_id);
alter table tags enable row level security;
alter table contract_tags enable row level security;
create policy t_tags on tags for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ctags on contract_tags for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_tags on tags as restrictive for all using (app_subscriber() is null);
create policy portal_ctags on contract_tags as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on tags, contract_tags to nexo_app;

-- ---- aviso de manutenção: o assinante afetado vê no portal ----
create table maintenance_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null check (char_length(title) between 3 and 120),
  message text not null check (char_length(message) between 3 and 1000),
  severity text not null default 'info' check (severity in ('info','degraded','outage')),
  device_id uuid,                                   -- vazio = todos os assinantes do provedor
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  canceled_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);
create index maintenance_notices_window on maintenance_notices (tenant_id, ends_at desc);
alter table maintenance_notices enable row level security;
create policy t_mnt on maintenance_notices for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on maintenance_notices to nexo_app;

-- ---- checklist da ordem de serviço ----
create table work_order_checklist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  position integer not null,
  label text not null check (char_length(label) between 2 and 160),
  done boolean not null default false,
  done_by uuid references users(id),
  done_at timestamptz,
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  unique (work_order_id, position)
);
alter table work_order_checklist enable row level security;
create policy t_wochk on work_order_checklist for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_wochk on work_order_checklist as restrictive for all using (app_subscriber() is null);
grant select, insert, update on work_order_checklist to nexo_app;

-- ---- equipamento instalado: comodato (continua do provedor) ou venda ----
alter table stock_units add column contract_mode text check (contract_mode in ('comodato','sale'));
alter table stock_units add constraint stock_units_mode_chk check ((status = 'installed') = (contract_mode is not null));
update stock_units set contract_mode = 'comodato' where status = 'installed';
-- +goose StatementEnd
