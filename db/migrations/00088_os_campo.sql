-- +goose Up
-- Trabalho de campo na OS: check-in/check-out do técnico, assinatura do cliente
-- guardada como documento privado da OS, legenda de foto e recibos idempotentes
-- das ações enviadas pela fila offline do navegador.
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('identity','address_proof','contract','photo','other','signature'));
alter table documents add constraint documents_signature_png check (kind <> 'signature' or (work_order_id is not null and mime = 'image/png'));
alter table documents add column caption text check (caption is null or (char_length(caption) between 1 and 200 and caption = btrim(caption)));

create table work_order_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  technician_id uuid not null references users(id),
  check_in_at timestamptz not null default now(),
  check_in_device_at timestamptz,
  check_in_latitude double precision,
  check_in_longitude double precision,
  check_in_accuracy_m double precision,
  check_in_distance_m double precision,
  check_out_at timestamptz,
  check_out_by uuid references users(id),
  check_out_reason text,
  check_out_device_at timestamptz,
  check_out_latitude double precision,
  check_out_longitude double precision,
  check_out_accuracy_m double precision,
  check_out_distance_m double precision,
  unique (tenant_id, id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  check (check_out_at is null or check_out_at >= check_in_at),
  check ((check_out_at is null) = (check_out_reason is null) and (check_out_at is null) = (check_out_by is null)),
  check (check_out_reason is null or check_out_reason in ('technician', 'os_finished')),
  check ((check_in_latitude is null) = (check_in_longitude is null)),
  check ((check_out_latitude is null) = (check_out_longitude is null)),
  check (check_in_latitude is null or (check_in_latitude between -90 and 90 and check_in_longitude between -180 and 180)),
  check (check_out_latitude is null or (check_out_latitude between -90 and 90 and check_out_longitude between -180 and 180)),
  check (check_in_accuracy_m is null or check_in_accuracy_m between 0 and 100000),
  check (check_out_accuracy_m is null or check_out_accuracy_m between 0 and 100000),
  check (check_in_distance_m is null or check_in_distance_m >= 0),
  check (check_out_distance_m is null or check_out_distance_m >= 0)
);
-- Um técnico tem no máximo uma presença aberta por OS.
create unique index work_order_visits_open on work_order_visits (tenant_id, work_order_id, technician_id) where check_out_at is null;
create index work_order_visits_order on work_order_visits (tenant_id, work_order_id, check_in_at);
alter table work_order_visits enable row level security;
create policy work_order_visits_tenant on work_order_visits for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy work_order_visits_portal on work_order_visits as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
create policy work_order_visits_pop on work_order_visits as restrictive for all
  using (exists (select 1 from work_orders w where w.id = work_order_visits.work_order_id))
  with check (exists (select 1 from work_orders w where w.id = work_order_visits.work_order_id));
grant select, insert, update on work_order_visits to nexo_app;

create table work_order_signatures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  work_order_id uuid not null,
  document_id uuid not null,
  signer_name text not null check (char_length(signer_name) between 2 and 120 and signer_name = btrim(signer_name)),
  signer_document text check (signer_document is null or (char_length(signer_document) between 3 and 30 and signer_document = btrim(signer_document))),
  signed_at timestamptz not null default now(),
  device_at timestamptz,
  signed_by uuid not null references users(id),
  unique (tenant_id, work_order_id),
  unique (tenant_id, document_id),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  foreign key (tenant_id, document_id) references documents (tenant_id, id)
);
alter table work_order_signatures enable row level security;
create policy work_order_signatures_tenant on work_order_signatures for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy work_order_signatures_portal on work_order_signatures as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
create policy work_order_signatures_pop on work_order_signatures as restrictive for all
  using (exists (select 1 from work_orders w where w.id = work_order_signatures.work_order_id))
  with check (exists (select 1 from work_orders w where w.id = work_order_signatures.work_order_id));
grant select, insert on work_order_signatures to nexo_app;

-- Recibo de cada ação de campo enviada com chave de idempotência: a repetição
-- devolve a resposta original e a mesma chave com outro conteúdo é recusada.
create table field_action_receipts (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  idempotency_key uuid not null,
  action text not null check (action in ('check_in', 'check_out', 'note', 'checklist_add', 'checklist_done')),
  work_order_id uuid not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  response json not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id, idempotency_key),
  foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id)
);
alter table field_action_receipts enable row level security;
create policy field_action_receipts_tenant on field_action_receipts for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy field_action_receipts_portal on field_action_receipts as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
create policy field_action_receipts_pop on field_action_receipts as restrictive for all
  using (exists (select 1 from work_orders w where w.id = field_action_receipts.work_order_id))
  with check (exists (select 1 from work_orders w where w.id = field_action_receipts.work_order_id));
grant select, insert on field_action_receipts to nexo_app;

-- A anonimização do titular também remove quem assinou, as legendas das fotos
-- e as coordenadas registradas no local do serviço; distâncias e horários ficam.
-- +goose StatementBegin
create function work_order_field_anonymize() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update work_order_signatures s set signer_name = 'Titular anonimizado', signer_document = null
    from work_orders w where w.id = s.work_order_id and w.tenant_id = s.tenant_id and w.subscriber_id = new.id and w.tenant_id = new.tenant_id;
  update work_order_visits v set check_in_latitude = null, check_in_longitude = null,
         check_out_latitude = null, check_out_longitude = null
    from work_orders w where w.id = v.work_order_id and w.tenant_id = v.tenant_id and w.subscriber_id = new.id and w.tenant_id = new.tenant_id;
  update documents set caption = null where subscriber_id = new.id and tenant_id = new.tenant_id and caption is not null;
  return null;
end $$;
-- +goose StatementEnd
revoke all on function work_order_field_anonymize() from public;
create trigger work_order_field_anonymize after update of anonymized_at on subscribers
  for each row when (old.anonymized_at is null and new.anonymized_at is not null) execute function work_order_field_anonymize();

-- +goose Down
drop trigger work_order_field_anonymize on subscribers;
drop function work_order_field_anonymize();
drop table field_action_receipts;
drop table work_order_signatures;
drop table work_order_visits;
delete from documents where kind = 'signature';
alter table documents drop column caption;
alter table documents drop constraint documents_signature_png;
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('identity','address_proof','contract','photo','other'));
