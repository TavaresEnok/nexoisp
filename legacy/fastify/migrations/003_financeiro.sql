-- E4: faturas, pagamentos, eventos do gateway, conciliação e política comercial explícita (ADR-010).

create table tenant_settings (
  tenant_id uuid primary key references tenants(id),
  timezone text not null default 'America/Sao_Paulo',      -- fuso usado para vencimentos e competência
  gateway text not null default 'none' check (gateway in ('none','demo')),
  billing_auto boolean not null default false,              -- geração automática mensal
  -- Política de suspensão: DESATIVADA até ser configurada explicitamente pelo provedor.
  auto_suspend boolean not null default false,
  suspend_after_days integer check (suspend_after_days between 0 and 365),
  auto_resume_on_payment boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (not auto_suspend or suspend_after_days is not null)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  subscriber_id uuid not null,
  kind text not null check (kind in ('monthly','manual')),
  competence date,                                          -- 1º dia do mês de referência (mensalidade)
  due_date date not null,
  amount_cents integer not null check (amount_cents > 0),   -- centavos inteiros
  status text not null default 'open' check (status in ('open','paid','reconciling','canceled')),
  status_note text,
  gateway text,
  gateway_charge_id text,
  payment_methods jsonb,
  external_source text, external_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  canceled_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  check ((kind = 'monthly') = (competence is not null))
);
-- Recorrência sem duplicação: uma fatura por contrato/competência/tipo.
create unique index invoices_recurrence_uq on invoices (tenant_id, contract_id, competence, kind) where competence is not null;
create unique index invoices_charge_uq on invoices (gateway, gateway_charge_id) where gateway_charge_id is not null;
create unique index invoices_ext_uq on invoices (tenant_id, external_source, external_id) where external_id is not null;
create index invoices_contract on invoices (tenant_id, contract_id, due_date desc);
create index invoices_subscriber on invoices (tenant_id, subscriber_id);

create table invoice_items (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null,
  description text not null,
  amount_cents integer not null,
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  paid_at timestamptz not null,
  method text,
  source text not null check (source in ('gateway_event','reconciliation','manual')),
  gateway text,
  gateway_payment_id text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id)
);
-- Pagamento do gateway entra uma única vez, venha por webhook, reenvio ou conciliação.
create unique index payments_gateway_uq on payments (gateway, gateway_payment_id) where gateway_payment_id is not null;

create table gateway_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references tenants(id),                    -- null = evento autêntico sem cobrança correspondente
  gateway text not null,
  event_id text not null,
  type text not null,
  charge_id text,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','ignored','divergent','unmatched')),
  note text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (gateway, event_id)
);

-- "Lado do provedor de pagamento" do GATEWAY DE DEMONSTRAÇÃO (simulação; não existe em integração real).
create table demo_gateway_charges (
  charge_id text primary key,
  tenant_id uuid not null references tenants(id),
  amount_cents integer not null,
  payments jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create function gateway_charge_tenant(p_gateway text, p_charge text) returns uuid
  language sql security definer set search_path = public as $$
  select tenant_id from invoices where gateway = p_gateway and gateway_charge_id = p_charge $$;
create function gateway_event_unmatched(p_gateway text, p_event text, p_type text, p_charge text, p_payload jsonb) returns void
  language sql security definer set search_path = public as $$
  insert into gateway_events (gateway, event_id, type, charge_id, payload, status, note)
  values (p_gateway, p_event, p_type, p_charge, p_payload, 'unmatched', 'cobrança não encontrada')
  on conflict (gateway, event_id) do nothing $$;
create function worker_tenants() returns table (tenant_id uuid, timezone text, gateway text, billing_auto boolean, auto_suspend boolean, suspend_after_days integer)
  language sql security definer set search_path = public as $$
  select t.id, coalesce(s.timezone, 'America/Sao_Paulo'), coalesce(s.gateway, 'none'), coalesce(s.billing_auto, false),
         coalesce(s.auto_suspend, false), s.suspend_after_days
  from tenants t left join tenant_settings s on s.tenant_id = t.id where t.status = 'active' $$;

alter table tenant_settings enable row level security;
alter table invoices enable row level security;
alter table invoice_items enable row level security;
alter table payments enable row level security;
alter table gateway_events enable row level security;
alter table demo_gateway_charges enable row level security;
create policy t_set on tenant_settings for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_inv on invoices for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_item on invoice_items for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_pay on payments for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_gev on gateway_events for all using (tenant_id = app_tenant() or (tenant_id is null and app_is_operator())) with check (tenant_id = app_tenant());
create policy t_demo on demo_gateway_charges for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

grant select, insert, update on tenant_settings, invoices, gateway_events, demo_gateway_charges to nexo_app;
grant select, insert on invoice_items, payments to nexo_app;   -- pagamentos e itens são históricos: sem update/delete
grant usage on all sequences in schema public to nexo_app;
revoke execute on function gateway_charge_tenant(text, text), gateway_event_unmatched(text, text, text, text, jsonb), worker_tenants() from public;
grant execute on function gateway_charge_tenant(text, text), gateway_event_unmatched(text, text, text, text, jsonb), worker_tenants() to nexo_app;
