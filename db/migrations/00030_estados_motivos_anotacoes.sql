-- +goose Up
-- +goose StatementBegin
-- D6/D7/D8: motivo de encerramento, restrição de crédito (negativação), anotações estruturadas com alerta.
alter table catalog_items drop constraint catalog_items_kind_check;
alter table catalog_items add constraint catalog_items_kind_check
  check (kind in ('ticket_type','classification','root_cause','origin','os_reason','end_reason','note_type'));

alter table contracts
  add column end_reason_id uuid,
  add column end_note text check (char_length(end_note) <= 300),
  add column credit_restricted_at timestamptz,          -- negativado: situação comercial à parte do acesso
  add constraint contracts_end_reason_fk foreign key (tenant_id, end_reason_id) references catalog_items (tenant_id, id),
  add constraint contracts_end_chk check (end_reason_id is null or status = 'ended');

create table subscriber_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscriber_id uuid not null,
  contract_id uuid,
  type_id uuid,
  body text not null check (char_length(body) between 1 and 2000),
  alert boolean not null default false,                 -- aparece como aviso ao abrir a ficha
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, type_id) references catalog_items (tenant_id, id)
);
create index subscriber_notes_sub on subscriber_notes (tenant_id, subscriber_id, created_at desc);

alter table subscriber_notes enable row level security;
create policy t_snt on subscriber_notes for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_snt on subscriber_notes as restrictive for all using (app_subscriber() is null);
grant select, insert, update on subscriber_notes to nexo_app;
-- +goose StatementEnd
