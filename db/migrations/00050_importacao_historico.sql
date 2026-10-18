-- +goose Up
-- +goose StatementBegin
-- Importação do histórico do sistema anterior (atendimentos, ordens de serviço e anotações), para o cliente não perder o passado ao migrar.
-- O registro importado guarda a origem e o id de lá: reimportar o mesmo arquivo não duplica.
alter table tickets add column external_source text, add column external_id text;
alter table work_orders add column external_source text, add column external_id text;
alter table subscriber_notes add column external_source text, add column external_id text;
create unique index tickets_ext_uq on tickets (tenant_id, external_source, external_id) where external_id is not null;
create unique index work_orders_ext_uq on work_orders (tenant_id, external_source, external_id) where external_id is not null;
create unique index subscriber_notes_ext_uq on subscriber_notes (tenant_id, external_source, external_id) where external_id is not null;
alter table import_batches drop constraint if exists import_batches_kind_check;
alter table import_batches add constraint import_batches_kind_check check (kind in ('subscribers','invoices','history'));
-- +goose StatementEnd
