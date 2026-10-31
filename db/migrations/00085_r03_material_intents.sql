-- +goose Up
create unique index stock_movements_tenant_id_id_uq on stock_movements (tenant_id, id);
create table material_intents (
  intention_id uuid primary key,
  tenant_id uuid not null references tenants(id),
  author_id uuid not null references users(id),
  work_order_id uuid not null,
  item_id uuid not null,
  qty integer not null check (qty <> 0 and qty between -10000 and 10000),
  movement_id bigint not null unique,
  receipt json not null,
  foreign key (tenant_id, work_order_id) references work_orders(tenant_id, id),
  foreign key (tenant_id, item_id) references stock_items(tenant_id, id),
  foreign key (tenant_id, movement_id) references stock_movements(tenant_id, id)
);
alter table material_intents enable row level security;
create policy material_intents_tenant on material_intents for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy material_intents_portal on material_intents as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
create policy material_intents_pop on material_intents as restrictive for all using (exists (select 1 from work_orders w where w.id = material_intents.work_order_id)) with check (exists (select 1 from work_orders w where w.id = material_intents.work_order_id));
grant select, insert on material_intents to nexo_app;
-- Only the existence bit is exposed, so collisions outside RLS return a generic 404.
create function material_intent_exists(p_id uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
  $$ select exists(select 1 from material_intents where intention_id = p_id) $$;
revoke all on function material_intent_exists(uuid) from public;
grant execute on function material_intent_exists(uuid) to nexo_app;

-- +goose Down
drop function material_intent_exists(uuid);
drop table material_intents;
drop index stock_movements_tenant_id_id_uq;
