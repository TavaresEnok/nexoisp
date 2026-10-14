-- RADIUS integrado: o servidor de autenticação sobe junto com o NexoISP e lê ESTE banco. O provedor não instala nada:
-- cadastra o concentrador no painel e aponta o equipamento para o endereço do sistema. O agente local continua existindo
-- como opção (driver mikrotik_radius) para quem quer autenticar com o enlace até o sistema fora do ar.
create extension if not exists pgcrypto;

alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','radius'));
-- fabricante do concentrador: define QUAIS atributos o RADIUS envia (perfil, velocidade, pool) — o protocolo é o mesmo
alter table devices add column vendor text check (vendor in ('mikrotik','huawei','cisco','generic'));
alter table devices add constraint devices_vendor_chk check ((driver = 'radius') = (vendor is not null));
-- executor interno do RADIUS integrado: ocupa o lugar do agente nas operações (mesma fila, mesmas garantias), sem credencial
alter table agents add column internal boolean not null default false;

-- O concentrador como cliente do RADIUS. É reconhecido pelo endereço de ORIGEM dos pacotes, único em toda a plataforma.
create table radius_nas (
  device_id uuid primary key references devices(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  nas_ip inet not null unique check (masklen(nas_ip) = 32 or (family(nas_ip) = 6 and masklen(nas_ip) = 128)),
  secret text not null check (char_length(secret) between 16 and 64),
  coa_host text check (char_length(coa_host) <= 200),       -- para onde mandar a desconexão, se não for o próprio nas_ip
  coa_port integer not null default 3799 check (coa_port between 1 and 65535),
  last_packet_at timestamptz,
  created_at timestamptz not null default now()
);

-- Conta: o que o RADIUS responde. A senha fica cifrada (pgp_sym_encrypt); só o servidor RADIUS tem a chave para ler.
create table radius_account (
  tenant_id uuid not null references tenants(id),
  username text not null,
  secret_enc bytea not null,
  policy text not null check (policy in ('active','suspended')),
  profile text not null,
  prev_profile text,
  by_profile boolean not null default false,
  applied_version integer not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, username)
);
create table radius_check (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  username text not null,
  attribute text not null,
  op text not null default ':=',
  value text not null,
  foreign key (tenant_id, username) references radius_account (tenant_id, username) on delete cascade
);
create index radius_check_user on radius_check (tenant_id, username);
create table radius_reply (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  username text not null,
  attribute text not null,
  op text not null default ':=',
  value text not null,
  foreign key (tenant_id, username) references radius_account (tenant_id, username) on delete cascade
);
create index radius_reply_user on radius_reply (tenant_id, username);

-- Accounting: gravado pelo servidor RADIUS a cada início, atualização e fim de sessão.
create table radius_acct (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unique_id text not null unique,
  session_id text not null,
  username text not null,
  nas_ip inet,
  nas_port text,
  started_at timestamptz not null,
  updated_at timestamptz not null,
  stopped_at timestamptz,
  session_seconds bigint not null default 0,
  bytes_in bigint not null default 0,          -- enviado pelo assinante
  bytes_out bigint not null default 0,         -- recebido pelo assinante
  calling_station text,
  called_station text,
  framed_ip text,
  terminate_cause text
);
create index radius_acct_open on radius_acct (tenant_id, username) where stopped_at is null;
create index radius_acct_recent on radius_acct (tenant_id, updated_at desc);

-- Tentativas de autenticação (aceitas e recusadas): é o "log do RADIUS" que o atendimento consulta.
create table radius_postauth (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  username text not null,
  reply text not null,
  calling_station text,
  nas_ip inet,
  at timestamptz not null default now()
);
create index radius_postauth_user on radius_postauth (tenant_id, username, id desc);

do $$ begin if not exists (select 1 from pg_roles where rolname = 'nexo_radius') then create role nexo_radius nologin; end if; end $$;

alter table radius_nas enable row level security;
alter table radius_account enable row level security;
alter table radius_check enable row level security;
alter table radius_reply enable row level security;
alter table radius_acct enable row level security;
alter table radius_postauth enable row level security;
-- aplicação: por provedor, como todo o resto
create policy t_rnas on radius_nas for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_racc on radius_account for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_rchk on radius_check for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_rrep on radius_reply for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ract on radius_acct for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_rpa on radius_postauth for all to nexo_app using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_rnas on radius_nas as restrictive for all to nexo_app using (app_subscriber() is null);
create policy portal_racc on radius_account as restrictive for all to nexo_app using (app_subscriber() is null);
create policy portal_rchk on radius_check as restrictive for all to nexo_app using (app_subscriber() is null);
create policy portal_rrep on radius_reply as restrictive for all to nexo_app using (app_subscriber() is null);
create policy portal_ract on radius_acct as restrictive for all to nexo_app using (app_subscriber() is null);
create policy portal_rpa on radius_postauth as restrictive for all to nexo_app using (app_subscriber() is null);
-- servidor RADIUS: enxerga todos os provedores (o provedor de cada pacote vem do concentrador que o enviou), mas só estas tabelas
create policy r_rnas on radius_nas for all to nexo_radius using (true) with check (true);
create policy r_racc on radius_account for select to nexo_radius using (true);
create policy r_rchk on radius_check for select to nexo_radius using (true);
create policy r_rrep on radius_reply for select to nexo_radius using (true);
create policy r_ract on radius_acct for all to nexo_radius using (true) with check (true);
create policy r_rpa on radius_postauth for insert to nexo_radius with check (true);

grant select, insert, update, delete on radius_nas, radius_account, radius_check, radius_reply to nexo_app;
grant select on radius_acct, radius_postauth to nexo_app;
grant usage on schema public to nexo_radius;
grant select on radius_account, radius_check, radius_reply to nexo_radius;
grant select, update (last_packet_at) on radius_nas to nexo_radius;
grant select, insert, update on radius_acct to nexo_radius;
grant insert on radius_postauth to nexo_radius;
grant usage on all sequences in schema public to nexo_app;
grant update on radius_acct to nexo_app;      -- fechar sessão que o concentrador diz não existir mais

-- O executor interno percorre todos os provedores que usam o RADIUS integrado; esta função devolve só o necessário para isso.
create function radius_internal_agents() returns table (tenant_id uuid, agent_id uuid)
  language sql stable security definer set search_path = public as $$
  select a.tenant_id, a.id from agents a join tenants t on t.id = a.tenant_id where a.internal and a.status = 'active' and t.status = 'active' $$;
revoke execute on function radius_internal_agents() from public;
grant execute on function radius_internal_agents() to nexo_app;
-- cifrar é da aplicação; abrir a senha é só do servidor RADIUS
grant execute on function pgp_sym_encrypt(text, text) to nexo_app;
grant execute on function pgp_sym_decrypt(bytea, text) to nexo_radius;
