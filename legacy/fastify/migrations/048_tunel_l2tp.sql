-- Túnel L2TP/IPsec para concentradores sem WireGuard (RouterOS 6, Huawei, Cisco): o concentrador disca para o NexoISP com
-- usuário e senha próprios e a chave IPsec da instalação; recebe um endereço fixo na faixa 10.251.0.0/16, pelo qual o RADIUS o reconhece.
create table l2tp_peers (
  device_id uuid primary key references devices(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  username text not null unique check (username ~ '^nx-[a-z0-9]{6,20}$'),
  secret_enc bytea not null,                         -- cifrada com a chave do RADIUS; só o serviço do túnel a lê
  tunnel_ip inet not null unique check (masklen(tunnel_ip) = 32 and tunnel_ip << '10.251.0.0/16'),
  last_seen_at timestamptz,                          -- última vez que o serviço viu a interface do concentrador no ar
  connected boolean not null default false,
  created_at timestamptz not null default now()
);
alter table l2tp_peers enable row level security;
create policy t_l2tp on l2tp_peers for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_l2tp on l2tp_peers as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on l2tp_peers to nexo_app;

create function l2tp_peers_all(p_key text) returns table (username text, secret text, tunnel_ip text)
  language sql stable security definer set search_path = public as $$
  select p.username, pgp_sym_decrypt(p.secret_enc, p_key), host(p.tunnel_ip) from l2tp_peers p join tenants t on t.id = p.tenant_id where t.status = 'active' $$;
create function l2tp_report(p_up text[]) returns void
  language sql security definer set search_path = public as $$
  update l2tp_peers set connected = host(tunnel_ip) = any(p_up), last_seen_at = case when host(tunnel_ip) = any(p_up) then now() else last_seen_at end
  where connected or host(tunnel_ip) = any(p_up) $$;
create function l2tp_free_ip() returns inet
  language sql stable security definer set search_path = public as $$
  select ('10.251.0.0'::inet + g) from generate_series(2, 65533) g
  where (g % 256) not in (0, 255) and not exists (select 1 from l2tp_peers p where p.tunnel_ip = '10.251.0.0'::inet + g) order by g limit 1 $$;
revoke execute on function l2tp_peers_all(text), l2tp_report(text[]), l2tp_free_ip() from public;
grant execute on function l2tp_peers_all(text), l2tp_report(text[]), l2tp_free_ip() to nexo_app;
