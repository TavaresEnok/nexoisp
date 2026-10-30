-- +goose Up
alter table documents add column work_order_id uuid;
alter table documents add constraint documents_work_order_fk foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id);
create index documents_work_order on documents (tenant_id, work_order_id, created_at desc) where work_order_id is not null and deleted_at is null;
create policy work_order_documents_scope on documents as restrictive for all
  using (work_order_id is null or exists (select 1 from work_orders w where w.id = work_order_id and w.tenant_id = documents.tenant_id and w.subscriber_id = documents.subscriber_id))
  with check (work_order_id is null or exists (select 1 from work_orders w where w.id = work_order_id and w.tenant_id = documents.tenant_id and w.subscriber_id = documents.subscriber_id));
