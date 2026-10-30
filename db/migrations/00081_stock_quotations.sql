-- +goose Up
-- +goose StatementBegin
create table stock_quotations (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
 title text not null check (char_length(title) between 3 and 120), note text not null default '' check (char_length(note)<=500),
 status text not null default 'draft' check (status in ('draft','converted','canceled')),
 created_at timestamptz not null default now(), purchase_order_id uuid, chosen_offer_id uuid,
 chosen_warehouse_id uuid, chosen_expected_at date, cancel_reason text,
 unique (tenant_id,id), foreign key (tenant_id,purchase_order_id) references purchase_orders(tenant_id,id),
 foreign key (tenant_id,chosen_warehouse_id) references stock_warehouses(tenant_id,id),
 check ((status='converted') = (purchase_order_id is not null and chosen_offer_id is not null))
);
create table stock_quotation_items (
 tenant_id uuid not null references tenants(id), quotation_id uuid not null, item_id uuid not null,
 qty integer not null check (qty between 1 and 1000000), primary key (quotation_id,item_id),
 unique (tenant_id,quotation_id,item_id),
 foreign key (tenant_id,quotation_id) references stock_quotations(tenant_id,id),
 foreign key (tenant_id,item_id) references stock_items(tenant_id,id)
);
create table stock_quotation_offers (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), quotation_id uuid not null,
 supplier_id uuid not null, note text not null default '' check(char_length(note)<=500), created_at timestamptz not null default now(),
 unique (tenant_id,quotation_id,id), foreign key (tenant_id,quotation_id) references stock_quotations(tenant_id,id),
 foreign key (tenant_id,supplier_id) references suppliers(tenant_id,id)
);
create table stock_quotation_prices (
 tenant_id uuid not null references tenants(id), quotation_id uuid not null, offer_id uuid not null, item_id uuid not null,
 unit_cost_cents integer not null check(unit_cost_cents between 0 and 100000000), primary key (offer_id,item_id),
 foreign key (tenant_id,quotation_id,offer_id) references stock_quotation_offers(tenant_id,quotation_id,id) on delete cascade,
 foreign key (tenant_id,quotation_id,item_id) references stock_quotation_items(tenant_id,quotation_id,item_id)
);
alter table stock_quotations add constraint stock_quotations_choice_fk foreign key (tenant_id,id,chosen_offer_id) references stock_quotation_offers(tenant_id,quotation_id,id);
create index stock_quotations_latest on stock_quotations(tenant_id,created_at desc,id desc);
create index stock_quotation_offers_quote on stock_quotation_offers(tenant_id,quotation_id);
do $$ declare t text; begin
 foreach t in array array['stock_quotations','stock_quotation_items','stock_quotation_offers','stock_quotation_prices'] loop
  execute format('alter table %I enable row level security',t);
  execute format('create policy tenant_scope on %I for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())',t);
  execute format('create policy portal_scope on %I as restrictive for all using (app_subscriber() is null and app_pops() is null) with check (app_subscriber() is null and app_pops() is null)',t);
 end loop;
end $$;
grant select,insert,update on stock_quotations to nexo_app;
grant select,insert on stock_quotation_items to nexo_app;
grant select,insert,delete on stock_quotation_offers,stock_quotation_prices to nexo_app;
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
alter table stock_quotations drop constraint stock_quotations_choice_fk;
drop table stock_quotation_prices, stock_quotation_offers, stock_quotation_items, stock_quotations;
-- +goose StatementEnd
