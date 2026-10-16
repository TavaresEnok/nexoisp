-- +goose Up
-- +goose StatementBegin
-- Avisos ao provedor por webhook (chamado aberto pelo portal, resposta do assinante, OS criada/atribuída).
-- Fila durável: o aviso é gravado na mesma transação do fato e entregue depois, com novas tentativas.
alter table tenant_settings add column notify_webhook_url text check (notify_webhook_url ~ '^https?://[^[:space:]]+$' and length(notify_webhook_url) <= 500);

create table notifications (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_due on notifications (tenant_id, next_attempt_at) where status = 'pending';

alter table notifications enable row level security;
create policy t_ntf on notifications for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
-- a sessão do portal grava o aviso do próprio chamado, mas não lê a fila
create policy portal_ntf on notifications as restrictive for select using (app_subscriber() is null);
grant select, insert, update on notifications to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
