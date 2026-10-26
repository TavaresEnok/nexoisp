-- +goose Up
-- +goose StatementBegin
-- Intervalos [início,fim): liberar/reutilizar um prefixo não perde a titularidade.
create table ip6_delegation_history (
  id uuid primary key default gen_random_uuid(),
  delegation_id uuid not null unique,
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  pool_id uuid not null,
  prefix cidr not null check (family(prefix) = 6),
  created_at timestamptz not null,
  released_at timestamptz,
  check (released_at is null or released_at >= created_at),
  exclude using gist (tenant_id with =, prefix inet_ops with &&,
    tstzrange(created_at, released_at, '[)') with &&)
);
insert into ip6_delegation_history (delegation_id,tenant_id,contract_id,pool_id,prefix,created_at)
  select id,tenant_id,contract_id,pool_id,prefix,created_at from ip6_delegations;
alter table ip6_delegation_history enable row level security;
create policy t_ip6_history on ip6_delegation_history for select using (tenant_id = app_tenant());
create policy portal_ip6_history on ip6_delegation_history as restrictive for select using (app_subscriber() is null);
create policy pop_ip6_history on ip6_delegation_history as restrictive for select
  using (app_pops() is null or exists (select 1 from contracts k where k.id = contract_id));
grant select on ip6_delegation_history to nexo_app;
create function ip6_history_record() returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.ip6_delegation_history (delegation_id,tenant_id,contract_id,pool_id,prefix,created_at)
      values (new.id,new.tenant_id,new.contract_id,new.pool_id,new.prefix,new.created_at);
    return new;
  elsif TG_OP = 'UPDATE' then
    raise exception 'libere a delegação antes de substituí-la';
  else
    update public.ip6_delegation_history set released_at = clock_timestamp()
      where delegation_id = old.id and released_at is null;
    return old;
  end if;
end $$;
revoke all on function ip6_history_record() from public;
create trigger ip6_history after insert or update or delete on ip6_delegations
  for each row execute function ip6_history_record();
-- +goose StatementEnd
