-- +goose Up
-- Projeto físico FTTH: cabos com traçado, fusões dentro de caixas, medições OTDR.
-- Registro cadastral: nenhuma linha aqui comprova conectividade física.
create table ftth_cables (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), pop_id uuid not null,
 name text not null check(char_length(name) between 2 and 120 and name=btrim(name)),
 kind text not null check(kind in ('aerial','underground','drop')),
 fiber_count integer not null check(fiber_count between 1 and 288),
 a_box_id uuid, a_site_id uuid, b_box_id uuid, b_site_id uuid,
 path jsonb not null check(jsonb_typeof(path)='array' and jsonb_array_length(path) between 2 and 500),
 computed_length_m double precision not null check(computed_length_m >= 0 and computed_length_m <= 1000000),
 declared_length_m double precision check(declared_length_m is null or (declared_length_m > 0 and declared_length_m <= 1000000)),
 min_lat double precision not null, max_lat double precision not null, min_lng double precision not null, max_lng double precision not null,
 notes text not null default '' check(char_length(notes)<=500), active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), unique(tenant_id,pop_id,id), unique(tenant_id,pop_id,name),
 foreign key(tenant_id,pop_id) references pops(tenant_id,id),
 foreign key(tenant_id,a_box_id) references ftth_boxes(tenant_id,id),
 foreign key(tenant_id,b_box_id) references ftth_boxes(tenant_id,id),
 foreign key(tenant_id,a_site_id) references network_sites(tenant_id,id),
 foreign key(tenant_id,b_site_id) references network_sites(tenant_id,id),
 check(a_box_id is null or a_site_id is null), check(b_box_id is null or b_site_id is null),
 check(min_lat between -90 and 90 and max_lat between -90 and 90 and min_lat<=max_lat and min_lng between -180 and 180 and max_lng between -180 and 180 and min_lng<=max_lng)
);
create index ftth_cables_scope on ftth_cables(tenant_id,pop_id,name,id);
create index ftth_cables_bbox on ftth_cables(tenant_id,min_lat,max_lat,min_lng,max_lng) where active;
create index ftth_cables_a_box on ftth_cables(a_box_id) where a_box_id is not null;
create index ftth_cables_b_box on ftth_cables(b_box_id) where b_box_id is not null;

-- Fusão: cabo A/fibra n com cabo B/fibra m ou com uma porta da caixa. Os dois
-- cabos pertencem ao POP da fusão (chave composta).
create table ftth_fusions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), pop_id uuid not null,
 box_id uuid not null,
 a_cable_id uuid not null, a_fiber integer not null check(a_fiber between 1 and 288),
 b_cable_id uuid, b_fiber integer check(b_fiber between 1 and 288), b_port integer check(b_port between 1 and 144),
 loss_db double precision check(loss_db is null or loss_db between -1 and 5),
 notes text not null default '' check(char_length(notes)<=200),
 created_by uuid, created_at timestamptz not null default now(),
 unique(tenant_id,id),
 foreign key(tenant_id,box_id) references ftth_boxes(tenant_id,id),
 foreign key(tenant_id,pop_id,a_cable_id) references ftth_cables(tenant_id,pop_id,id),
 foreign key(tenant_id,pop_id,b_cable_id) references ftth_cables(tenant_id,pop_id,id),
 check((b_cable_id is not null and b_fiber is not null and b_port is null) or (b_cable_id is null and b_fiber is null and b_port is not null)),
 check(b_cable_id is null or b_cable_id<>a_cable_id or b_fiber<>a_fiber)
);
create index ftth_fusions_box on ftth_fusions(tenant_id,box_id,created_at,id);
create index ftth_fusions_a on ftth_fusions(a_cable_id);
create index ftth_fusions_b on ftth_fusions(b_cable_id) where b_cable_id is not null;
create unique index ftth_fusions_port on ftth_fusions(box_id,b_port) where b_port is not null;
-- Cada extremidade de fibra ocupa uma linha: a chave primária impede que a
-- mesma fibra seja fundida duas vezes na mesma caixa, em qualquer lado.
create table ftth_fusion_fibers (
 tenant_id uuid not null references tenants(id), pop_id uuid not null, fusion_id uuid not null,
 box_id uuid not null, cable_id uuid not null, fiber integer not null check(fiber between 1 and 288),
 primary key(box_id,cable_id,fiber),
 foreign key(tenant_id,fusion_id) references ftth_fusions(tenant_id,id) on delete cascade,
 foreign key(tenant_id,pop_id,cable_id) references ftth_cables(tenant_id,pop_id,id)
);
create index ftth_fusion_fibers_fusion on ftth_fusion_fibers(fusion_id);
create index ftth_fusion_fibers_cable on ftth_fusion_fibers(cable_id,fiber);

create table ftth_otdr_measurements (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), pop_id uuid not null,
 cable_id uuid not null, fiber integer not null check(fiber between 1 and 288),
 measured_on date not null,
 wavelength_nm integer not null check(wavelength_nm in (1310,1550,1625)),
 total_distance_m double precision not null check(total_distance_m > 0 and total_distance_m <= 300000),
 total_loss_db double precision not null check(total_loss_db between 0 and 100),
 events jsonb not null default '[]'::jsonb check(jsonb_typeof(events)='array' and jsonb_array_length(events)<=200),
 technician text not null check(char_length(technician) between 2 and 120 and technician=btrim(technician)),
 notes text not null default '' check(char_length(notes)<=500),
 file_name text, file_size integer, file_sha256 text, file_content bytea,
 created_by uuid, created_at timestamptz not null default now(),
 unique(tenant_id,id),
 foreign key(tenant_id,pop_id,cable_id) references ftth_cables(tenant_id,pop_id,id),
 check((file_content is null and file_name is null and file_size is null and file_sha256 is null) or (file_content is not null and char_length(file_name) between 1 and 120 and file_size between 1 and 5242880 and octet_length(file_content)=file_size and file_sha256 ~ '^[0-9a-f]{64}$'))
);
create index ftth_otdr_cable on ftth_otdr_measurements(tenant_id,cable_id,measured_on desc,id);

alter table ftth_cables enable row level security;
alter table ftth_fusions enable row level security;
alter table ftth_fusion_fibers enable row level security;
alter table ftth_otdr_measurements enable row level security;
create policy ftth_cables_scope on ftth_cables for all using (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops()))) with check (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops())));
create policy ftth_fusions_scope on ftth_fusions for all using (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops()))) with check (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops())));
create policy ftth_fusion_fibers_scope on ftth_fusion_fibers for all using (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops()))) with check (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops())));
create policy ftth_otdr_scope on ftth_otdr_measurements for all using (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops()))) with check (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops())));
grant select,insert,update on ftth_cables to nexo_app;
grant select,insert,delete on ftth_fusions, ftth_fusion_fibers to nexo_app;
grant select,insert on ftth_otdr_measurements to nexo_app;
-- +goose Down
drop table ftth_otdr_measurements;
drop table ftth_fusion_fibers;
drop table ftth_fusions;
drop table ftth_cables;
