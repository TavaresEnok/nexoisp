-- +goose Up
-- +goose StatementBegin
-- Lote 7: fidelidade com multa rescisória (C8), mudança agendada e aditivos (C9), desconto temporário e indicação (C10).

-- C8: carência. O plano traz o padrão; o contrato guarda o que valeu para ele.
alter table plans
  add column loyalty_months integer check (loyalty_months between 1 and 60),
  add column penalty_model text check (penalty_model in ('fixed','monthly')),     -- fixed: valor único; monthly: valor por mês restante
  add column penalty_cents integer check (penalty_cents >= 0),
  add constraint plans_loyalty_chk check ((loyalty_months is null) = (penalty_model is null) and (penalty_model is null) = (penalty_cents is null));

alter table contracts
  add column loyalty_until date,
  add column penalty_model text check (penalty_model in ('fixed','monthly')),
  add column penalty_cents integer check (penalty_cents >= 0),
  add column referred_by_subscriber_id uuid,
  add constraint contracts_loyalty_chk check ((loyalty_until is null) = (penalty_model is null) and (penalty_model is null) = (penalty_cents is null)),
  add constraint contracts_referrer_fk foreign key (tenant_id, referred_by_subscriber_id) references subscribers (tenant_id, id);

-- C10: desconto sobre a mensalidade (percentual ou valor), por prazo ou até cancelar.
create table contract_discounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  kind text not null check (kind in ('percent','fixed')),
  value integer not null check (value > 0),                           -- percentual (1..100) ou centavos
  reason text not null check (char_length(reason) between 3 and 120),
  from_competence date not null check (extract(day from from_competence) = 1),
  months integer check (months between 1 and 120),                    -- nulo = sem fim, até cancelar
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  canceled_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check (kind <> 'percent' or value <= 100)
);
create index contract_discounts_contract on contract_discounts (tenant_id, contract_id) where canceled_at is null;

-- C9: mudança agendada (aplicada pela rotina periódica na data, em nome do sistema).
create table scheduled_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  kind text not null check (kind in ('plan_change','due_day','end')),
  effective_date date not null,
  plan_id uuid,
  due_day integer check (due_day between 1 and 28),
  end_reason_id uuid,
  penalty text check (penalty in ('charge','waive')),
  penalty_waive_reason text check (char_length(penalty_waive_reason) <= 200),
  note text check (char_length(note) <= 300),
  status text not null default 'pending' check (status in ('pending','applied','canceled','failed')),
  error text check (char_length(error) <= 300),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, plan_id) references plans (tenant_id, id),
  foreign key (tenant_id, end_reason_id) references catalog_items (tenant_id, id),
  check ((kind = 'plan_change') = (plan_id is not null)),
  check ((kind = 'due_day') = (due_day is not null))
);
create index scheduled_changes_due on scheduled_changes (tenant_id, effective_date) where status = 'pending';

-- C9: aditivo contratual (registro documental com data de vigência; não é assinatura eletrônica).
create table contract_amendments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  kind text not null check (kind in ('address','holder','plan','condition','other')),
  title text not null check (char_length(title) between 3 and 120),
  body text not null check (char_length(body) between 1 and 4000),
  effective_date date not null default current_date,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id)
);
create index contract_amendments_contract on contract_amendments (tenant_id, contract_id, created_at desc);

-- Valor-base da mensalidade da competência (preço do plano ou proporcional ao primeiro mês) e desconto aplicável.
create function contract_base_cents(p_contract uuid, p_competence date, p_prorate boolean) returns integer
  language sql stable as $$
  select case when p_prorate and k.start_date > p_competence
              then greatest(1, round(pv.price_cents::numeric * ((p_competence + interval '1 month')::date - k.start_date)
                                     / ((p_competence + interval '1 month')::date - p_competence))::int)
              else pv.price_cents end
  from contracts k join plan_versions pv on pv.id = k.plan_version_id where k.id = p_contract $$;

create function contract_discount_cents(p_contract uuid, p_competence date, p_base integer) returns integer
  language sql stable as $$
  select least(p_base, coalesce(sum(case d.kind when 'percent' then round(p_base::numeric * d.value / 100) else d.value end), 0))::int
  from contract_discounts d
  where d.contract_id = p_contract and d.canceled_at is null and d.from_competence <= p_competence
    and (d.months is null or p_competence < (d.from_competence + make_interval(months => d.months))::date) $$;

alter table contract_discounts enable row level security;
alter table scheduled_changes enable row level security;
alter table contract_amendments enable row level security;
create policy t_cdi on contract_discounts for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_sch on scheduled_changes for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_cam on contract_amendments for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cdi on contract_discounts as restrictive for all using (app_subscriber() is null);
create policy portal_sch on scheduled_changes as restrictive for all using (app_subscriber() is null);
create policy portal_cam on contract_amendments as restrictive for all using (app_subscriber() is null);
grant select, insert, update on contract_discounts, scheduled_changes, contract_amendments to nexo_app;
grant execute on function contract_base_cents(uuid, date, boolean), contract_discount_cents(uuid, date, integer) to nexo_app;
-- +goose StatementEnd
