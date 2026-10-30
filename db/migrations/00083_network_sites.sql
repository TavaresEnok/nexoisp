-- +goose Up
create table network_sites (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), pop_id uuid not null,
 kind text not null check(kind in ('pole','tower','building')),
 name text not null check(char_length(name) between 2 and 120 and name=btrim(name)),
 city text check(city is null or (char_length(city)<=100 and city=btrim(city))),
 address text check(address is null or (char_length(address)<=300 and address=btrim(address))),
 latitude double precision, longitude double precision,
 notes text not null default '' check(char_length(notes)<=500), active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id), foreign key(tenant_id,pop_id) references pops(tenant_id,id),
 check ((latitude is null and longitude is null) or (latitude is not null and longitude is not null and latitude between -90 and 90 and longitude between -180 and 180))
);
create index network_sites_scope on network_sites(tenant_id,pop_id,kind,name,id);
alter table network_sites enable row level security;
create policy network_sites_scope on network_sites for all using (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops()))) with check (tenant_id=app_tenant() and app_subscriber() is null and (app_pops() is null or pop_id=any(app_pops())));
grant select,insert,update on network_sites to nexo_app;
-- +goose Down
drop table network_sites;
