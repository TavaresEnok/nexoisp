-- Consumo mensal por conta PPPoE, lido do accounting do RADIUS local pelo agente (0.4.0+).
-- O agente relata o TOTAL do mês corrente e do anterior; o relato mais novo substitui o anterior (idempotente).
create table usage_monthly (
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null references service_resources(id),
  month date not null check (month = date_trunc('month', month)::date),   -- 1º dia do mês, em UTC
  bytes_in bigint not null default 0 check (bytes_in >= 0),     -- enviado pelo assinante (upload)
  bytes_out bigint not null default 0 check (bytes_out >= 0),   -- recebido pelo assinante (download)
  session_seconds bigint not null default 0 check (session_seconds >= 0),
  sessions integer not null default 0 check (sessions >= 0),
  reported_at timestamptz not null default now(),
  primary key (resource_id, month)
);
create index usage_monthly_tenant on usage_monthly (tenant_id, month);
alter table usage_monthly enable row level security;
create policy t_usage on usage_monthly for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
-- o assinante só enxerga o consumo das próprias contas
create policy portal_usage on usage_monthly as restrictive for all using (
  app_subscriber() is null or exists (select 1 from service_resources r join contracts k on k.id = r.contract_id
                                      where r.id = usage_monthly.resource_id and k.subscriber_id = app_subscriber()));
grant select, insert, update on usage_monthly to nexo_app;
