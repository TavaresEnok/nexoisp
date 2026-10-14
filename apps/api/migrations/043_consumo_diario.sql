-- Consumo por dia (e, somando, por semana e por ano) das contas atendidas pelo RADIUS integrado.
-- Alimentado pela diferença entre uma leitura do accounting e a anterior, no dia (fuso do provedor) em que a diferença apareceu;
-- por isso uma sessão longa deixa de cair inteira no mês/dia em que começou. Precisão = intervalo entre atualizações do concentrador.
create table usage_daily (
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null references service_resources(id),
  day date not null,
  bytes_in bigint not null default 0 check (bytes_in >= 0),      -- enviado pelo assinante (upload)
  bytes_out bigint not null default 0 check (bytes_out >= 0),    -- recebido pelo assinante (download)
  primary key (resource_id, day)
);
create index usage_daily_tenant on usage_daily (tenant_id, day);
alter table usage_daily enable row level security;
create policy t_usage_daily on usage_daily for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_usage_daily on usage_daily as restrictive for all using (
  app_subscriber() is null or exists (select 1 from service_resources r join contracts k on k.id = r.contract_id
                                      where r.id = usage_daily.resource_id and k.subscriber_id = app_subscriber()));
grant select, insert, update, delete on usage_daily to nexo_app;
