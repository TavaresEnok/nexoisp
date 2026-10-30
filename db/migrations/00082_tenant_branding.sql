-- +goose Up
create table tenant_branding (
 tenant_id uuid primary key references tenants(id),
 display_name text check (display_name is null or char_length(display_name) between 2 and 80),
 logo_png bytea, logo_sha256 text, logo_width integer, logo_height integer,
 updated_at timestamptz not null default now(),
 check ((logo_png is null and logo_sha256 is null and logo_width is null and logo_height is null) or
        (logo_png is not null and octet_length(logo_png) between 1 and 2097152 and logo_sha256 is not null and logo_width is not null and logo_height is not null and logo_sha256 ~ '^[0-9a-f]{64}$' and logo_width between 1 and 512 and logo_height between 1 and 512))
);
alter table tenant_branding enable row level security;
create policy branding_read on tenant_branding for select using (tenant_id=app_tenant());
create policy branding_insert on tenant_branding for insert with check (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
create policy branding_update on tenant_branding for update using (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null) with check (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
grant select,insert,update on tenant_branding to nexo_app;
-- +goose Down
drop table tenant_branding;
