-- +goose Up
-- +goose StatementBegin
-- Consumo por hora das contas do RADIUS integrado, só da janela recente (padrão 48 h, NEXO_USAGE_HOURLY_HOURS).
-- Guardar a hora de todas as contas para sempre custaria ~2,4 milhões de linhas/dia com 100 mil contas: a janela curta resolve o
-- uso real (atendimento: "a internet ficou lenta ontem à noite?") e a limpeza periódica mantém a tabela pequena.
create table usage_hourly (
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null references service_resources(id),
  hour timestamptz not null check (hour = date_trunc('hour', hour)),
  bytes_in bigint not null default 0 check (bytes_in >= 0),
  bytes_out bigint not null default 0 check (bytes_out >= 0),
  primary key (resource_id, hour)
);
create index usage_hourly_tenant on usage_hourly (tenant_id, hour);
alter table usage_hourly enable row level security;
create policy t_usage_hourly on usage_hourly for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_usage_hourly on usage_hourly as restrictive for all using (
  app_subscriber() is null or exists (select 1 from service_resources r join contracts k on k.id = r.contract_id
                                      where r.id = usage_hourly.resource_id and k.subscriber_id = app_subscriber()));
grant select, insert, update, delete on usage_hourly to nexo_app;
-- +goose StatementEnd
