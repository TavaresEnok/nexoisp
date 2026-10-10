-- Expansão 2 (pós-MVP): IPAM e CGNAT — planejamento, validação, script revisável e rastreabilidade.
-- O ERP não encaminha pacotes nem executa NAT: registra o plano e gera a configuração para revisão humana.

create extension if not exists btree_gist;

create table ip_pools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  cidr cidr not null,
  kind text not null check (kind in ('public','cgnat','private','management')),
  device_id uuid,                                   -- NAS/BNG que usa o bloco (opcional)
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, device_id) references devices (tenant_id, id),
  -- dois blocos do mesmo provedor não podem se sobrepor
  constraint ip_pools_no_overlap exclude using gist (tenant_id with =, cidr inet_ops with &&)
);

-- Endereço reservado ou fixo de um contrato. Um endereço pertence a no máximo uma alocação por provedor.
create table ip_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  pool_id uuid not null,
  address inet not null check (masklen(address) = case family(address) when 4 then 32 else 128 end),
  contract_id uuid,
  description text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, address),
  foreign key (tenant_id, pool_id) references ip_pools (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check (contract_id is not null or description is not null)
);
create index ip_allocations_contract on ip_allocations (tenant_id, contract_id) where contract_id is not null;
create index ip_allocations_pool on ip_allocations (pool_id);

-- Plano de CGNAT determinístico: cada IP privado recebe um bloco fixo de portas em um IP público.
-- Imutável depois de criado (a rastreabilidade de datas passadas depende disso); para mudar, encerra-se o plano e cria-se outro.
create table cgnat_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  public_pool_id uuid not null,
  private_pool_id uuid not null,
  public_cidr cidr not null,                        -- cópia dos blocos no momento da criação
  private_cidr cidr not null,
  ports_per_subscriber integer not null check (ports_per_subscriber between 64 and 32768),
  port_start integer not null default 1024 check (port_start between 1024 and 65000),
  created_by uuid,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, public_pool_id) references ip_pools (tenant_id, id),
  foreign key (tenant_id, private_pool_id) references ip_pools (tenant_id, id),
  check (family(public_cidr) = 4 and family(private_cidr) = 4)
);
create unique index cgnat_plans_private_uq on cgnat_plans (tenant_id, private_pool_id) where retired_at is null;

alter table ip_pools enable row level security;
alter table ip_allocations enable row level security;
alter table cgnat_plans enable row level security;
create policy t_ipp on ip_pools for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ipa on ip_allocations for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_cgn on cgnat_plans for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_ipp on ip_pools as restrictive for all using (app_subscriber() is null);
create policy portal_ipa on ip_allocations as restrictive for all using (app_subscriber() is null);
create policy portal_cgn on cgnat_plans as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on ip_pools, ip_allocations to nexo_app;
grant select, insert, update on cgnat_plans to nexo_app;   -- plano de CGNAT não é apagado: fica encerrado para consultas históricas
