-- +goose Up
-- +goose StatementBegin
-- IPv6 no IPAM: prefixo delegado por contrato (planejamento e registro). A entrega pelo RADIUS não é feita por este módulo.
alter table ip_pools add column delegation_len integer check (delegation_len between 48 and 64);
alter table ip_pools add constraint ip_pools_delegation_v6 check (delegation_len is null or (family(cidr) = 6 and delegation_len >= masklen(cidr)));

create table ip6_delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  pool_id uuid not null,
  prefix cidr not null check (family(prefix) = 6),
  contract_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, contract_id),
  foreign key (tenant_id, pool_id) references ip_pools (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  constraint ip6_delegations_no_overlap exclude using gist (tenant_id with =, prefix inet_ops with &&)
);
create index ip6_delegations_pool on ip6_delegations (pool_id);
alter table ip6_delegations enable row level security;
create policy t_ip6 on ip6_delegations for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_ip6 on ip6_delegations as restrictive for all using (app_subscriber() is null);
grant select, insert, delete on ip6_delegations to nexo_app;
-- +goose StatementEnd
