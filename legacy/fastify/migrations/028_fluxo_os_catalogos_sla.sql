-- Lote 4 (paridade): fluxo de status da OS com deslocamento (F1), catálogos (F2), SLA (F3),
-- agenda (F4), endereço por serviço e da OS (F6) e pesquisa de satisfação (C7).
-- Atendimento continua sendo por ocorrência e OS; nada aqui é chat.

-- F1: novos estados. "Atribuída" não é estado: é o responsável preenchido (evento "assigned").
alter table work_orders drop constraint if exists work_orders_status_check;
alter table work_orders add constraint work_orders_status_check
  check (status in ('open','analysis','awaiting_schedule','scheduled','en_route','in_progress','done','canceled'));
alter table work_orders add column en_route_at timestamptz;          -- saiu para o local (deslocamento)
alter table work_orders add column started_at timestamptz;           -- primeira vez em execução
alter table work_orders add column awaiting_reason text check (char_length(awaiting_reason) <= 300);
alter table work_orders add column estimated_minutes integer not null default 60 check (estimated_minutes between 5 and 1440);
drop index if exists work_orders_open;
create index work_orders_open on work_orders (tenant_id, scheduled_for)
  where status in ('open','analysis','awaiting_schedule','scheduled','en_route','in_progress');

-- F2: catálogos do provedor. O tipo (kind) do item é conferido pela API ao vincular.
create table catalog_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('ticket_type','classification','root_cause','origin','os_reason')),
  name text not null check (char_length(name) between 2 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, name)
);
alter table tickets
  add column type_id uuid, add column classification_id uuid, add column root_cause_id uuid, add column origin_id uuid,
  add constraint tickets_type_fk foreign key (tenant_id, type_id) references catalog_items (tenant_id, id),
  add constraint tickets_class_fk foreign key (tenant_id, classification_id) references catalog_items (tenant_id, id),
  add constraint tickets_cause_fk foreign key (tenant_id, root_cause_id) references catalog_items (tenant_id, id),
  add constraint tickets_origin_fk foreign key (tenant_id, origin_id) references catalog_items (tenant_id, id);
alter table work_orders
  add column reason_id uuid, add column root_cause_id uuid,
  add constraint wo_reason_fk foreign key (tenant_id, reason_id) references catalog_items (tenant_id, id),
  add constraint wo_cause_fk foreign key (tenant_id, root_cause_id) references catalog_items (tenant_id, id);

-- F3: SLA por tipo e prioridade. Prazos em minutos corridos (sem calendário de expediente).
create table sla_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  applies_to text not null check (applies_to in ('ticket','work_order')),
  priority text check (priority in ('low','normal','high')),         -- só atendimentos
  kind text check (kind in ('install','repair','address_change','removal','other')),   -- só OS
  type_id uuid,                                                      -- tipo de ocorrência (catálogo), só atendimentos
  resolution_minutes integer not null check (resolution_minutes between 5 and 525600),
  escalate_to uuid references users(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, type_id) references catalog_items (tenant_id, id),
  check (applies_to = 'ticket' or (priority is null and type_id is null)),
  check (applies_to = 'work_order' or kind is null)
);
alter table tickets add column sla_policy_id uuid, add column sla_due_at timestamptz, add column sla_breached_at timestamptz,
  add constraint tickets_sla_fk foreign key (tenant_id, sla_policy_id) references sla_policies (tenant_id, id);
alter table work_orders add column sla_policy_id uuid, add column sla_due_at timestamptz, add column sla_breached_at timestamptz,
  add constraint wo_sla_fk foreign key (tenant_id, sla_policy_id) references sla_policies (tenant_id, id);
create index tickets_sla_open on tickets (tenant_id, sla_due_at) where status <> 'closed' and sla_breached_at is null and sla_due_at is not null;
create index wo_sla_open on work_orders (tenant_id, sla_due_at) where status not in ('done','canceled') and sla_breached_at is null and sla_due_at is not null;

-- F6: endereço de instalação por serviço (contrato) e endereço da OS (origem registrada).
alter table contracts
  add column install_street text, add column install_number text, add column install_district text,
  add column install_city text, add column install_state text, add column install_zip text;
alter table work_orders
  add column address_origin text not null default 'subscriber' check (address_origin in ('subscriber','contract','manual')),
  add column address_text text check (char_length(address_text) <= 300);

-- C7: pesquisa de satisfação depois da OS (uma por OS). Respondida pelo portal do assinante.
create table satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  work_order_number bigint not null,         -- cópia: o portal não lê a tabela de OS
  kind text not null,
  subscriber_id uuid not null,
  score integer check (score between 1 and 5),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  answered_at timestamptz,
  unique (tenant_id, id),
  unique (work_order_id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  check ((score is null) = (answered_at is null))
);
create index surveys_subscriber on satisfaction_surveys (tenant_id, subscriber_id, created_at desc);

alter table catalog_items enable row level security;
alter table sla_policies enable row level security;
alter table satisfaction_surveys enable row level security;
create policy t_cat on catalog_items for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_sla on sla_policies for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_srv on satisfaction_surveys for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cat on catalog_items as restrictive for all using (app_subscriber() is null);
create policy portal_sla on sla_policies as restrictive for all using (app_subscriber() is null);
-- Assinante: só as próprias pesquisas.
create policy portal_srv on satisfaction_surveys as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
grant select, insert, update, delete on catalog_items, sla_policies to nexo_app;
grant select, insert, update on satisfaction_surveys to nexo_app;
grant usage on all sequences in schema public to nexo_app;
