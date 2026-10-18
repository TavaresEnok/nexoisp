-- +goose Up
-- +goose StatementBegin
create table cells (
  id text primary key check (id ~ '^c[0-9]+$'), name text not null,
  status text not null default 'active' check (status in ('active','draining','readonly')),
  created_at timestamptz not null default now()
);
create table tenant_cells (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  cell_id text not null references cells(id), since timestamptz not null default now()
);
alter table tenant_cells enable row level security;
create policy tenant_cells_read on tenant_cells for select using (tenant_id = app_tenant());
revoke all on cells, tenant_cells from public;
grant select on cells, tenant_cells to nexo_go;
insert into cells (id,name) values ('c1','célula principal');
insert into tenant_cells (tenant_id,cell_id) select id,'c1' from tenants;
create function tenant_cells_default() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  insert into public.tenant_cells (tenant_id,cell_id) values (new.id,'c1') on conflict do nothing;
  return new;
end $$;
revoke all on function tenant_cells_default() from public;
create trigger tenant_cells_default after insert on tenants for each row execute function tenant_cells_default();
-- Diretório global de metadados, sem acesso às tabelas de negócio e sem credencial privilegiada na API.
create function nexo_go_directory() returns table (tenant_id uuid, cell_id text)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.tenant_id,t.cell_id from public.tenant_cells t join public.cells c on c.id=t.cell_id
  where c.status = 'active' $$;
revoke all on function nexo_go_directory() from public;
grant execute on function nexo_go_directory() to nexo_go;
create function nexo_cells_notify() returns trigger language plpgsql
  set search_path = pg_catalog, public as $$
begin
  perform pg_notify('nexo_auth',jsonb_build_object('k','cell','at',clock_timestamp())::text);
  return null;
end $$;
revoke all on function nexo_cells_notify() from public;
create trigger nexo_cells_directory after insert or update or delete on tenant_cells for each statement execute function nexo_cells_notify();
create trigger nexo_cells_status after update or delete on cells for each statement execute function nexo_cells_notify();
-- +goose StatementEnd
