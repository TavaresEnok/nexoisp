-- +goose Up
-- +goose StatementBegin
-- Financeiro avançado (comparativo com o SGP, docs/07): liberação por confiança, baixa parcial com desconto, estorno de baixa,
-- multa e juros por atraso, acordo de pagamento e mensalidade proporcional. Tudo opt-in por provedor: com os padrões, nada muda.

-- ---- política (valores padrão = comportamento anterior) ----
alter table tenant_settings
  add column trust_release_enabled boolean not null default false,
  add column trust_release_days integer not null default 3 check (trust_release_days between 1 and 30),       -- prazo máximo de cada liberação
  add column trust_release_gap_days integer not null default 30 check (trust_release_gap_days between 0 and 365), -- intervalo mínimo entre liberações
  add column late_fee_percent numeric(5,2) not null default 0 check (late_fee_percent between 0 and 20),        -- multa única sobre o valor
  add column interest_monthly_percent numeric(5,2) not null default 0 check (interest_monthly_percent between 0 and 20), -- juros ao mês, pro rata por dia
  add column prorate_first_month boolean not null default false;

-- ---- liberação por confiança (promessa de pagamento) ----
create table trust_releases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  source text not null check (source in ('operator','portal')),
  requested_by uuid,                       -- usuário da equipe ou do portal
  reason text,
  days integer not null check (days between 1 and 30),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active','expired','settled','canceled')),
  closed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id)
);
create index trust_releases_contract on trust_releases (tenant_id, contract_id, granted_at desc);
alter table trust_releases enable row level security;
create policy t_trust on trust_releases for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, update on trust_releases to nexo_app;

-- ---- pagamentos: estorno é uma linha nova (a tabela segue só com insert) ----
alter table payments
  add column kind text not null default 'payment' check (kind in ('payment','reversal')),
  add column reversal_of uuid references payments(id),
  add column signed_cents integer generated always as (case when kind = 'reversal' then -amount_cents else amount_cents end) stored,
  add constraint payments_reversal_chk check ((kind = 'reversal') = (reversal_of is not null));
create unique index payments_one_reversal_uq on payments (reversal_of) where reversal_of is not null;

-- ---- faturas: ajustes de multa/juros e desconto ficam fora do valor original (que é o da cobrança no gateway) ----
alter table invoices
  add column fee_cents integer not null default 0 check (fee_cents >= 0),
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  add column agreement_id uuid,
  drop constraint invoices_kind_check,
  add constraint invoices_kind_check check (kind in ('monthly','manual','agreement'));

-- ---- acordo de pagamento ----
create table agreements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  subscriber_id uuid not null,
  total_cents integer not null check (total_cents > 0),
  original_cents integer not null check (original_cents > 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  installments integer not null check (installments between 1 and 24),
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id)
);
alter table agreements enable row level security;
create policy t_agr on agreements for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert on agreements to nexo_app;
alter table invoices add constraint invoices_agreement_fk foreign key (tenant_id, agreement_id) references agreements (tenant_id, id);
create index invoices_agreement on invoices (tenant_id, agreement_id) where agreement_id is not null;
-- +goose StatementEnd
