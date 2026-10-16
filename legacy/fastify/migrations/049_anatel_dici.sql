-- Coleta mensal de acessos da ANATEL (DICI, SCM): quantos acessos em serviço por município (código IBGE), tipo de cliente,
-- área (urbana/rural), meio, tecnologia e velocidade, por CNPJ. Os dados que faltavam no cadastro:
--   tecnologia de acesso do plano, área do contrato, e o código IBGE de cada município atendido (tabela do provedor).
alter table plans add column access_technology text check (access_technology in ('FTTH','FTTB','HFC','XDSL','ETHERNET','RADIO','LTE','SATELITE','OUTRA'));
alter table contracts add column service_area text not null default 'urban' check (service_area in ('urban','rural'));

-- Normaliza o nome do município para casar o texto do endereço com a tabela (maiúsculas, sem acento, espaços simples).
create function norm_city(p text) returns text language sql immutable as $$
  select upper(regexp_replace(translate(trim(coalesce(p, '')),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'), '\s+', ' ', 'g')) $$;

create table municipalities (
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  state text not null check (state ~ '^[A-Z]{2}$'),
  ibge_code text not null check (ibge_code ~ '^[0-9]{7}$'),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, state, name)
);
create unique index municipalities_norm on municipalities (tenant_id, state, norm_city(name));
alter table municipalities enable row level security;
create policy t_mun on municipalities for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_mun on municipalities as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on municipalities to nexo_app;
grant execute on function norm_city(text) to nexo_app;
