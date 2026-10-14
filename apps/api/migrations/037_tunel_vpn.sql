-- Túnel integrado: o concentrador disca para o NexoISP (WireGuard) e a autenticação passa por dentro do túnel. O provedor não
-- precisa de IP público nem de liberar portas de entrada; funciona atrás de NAT. Cada concentrador recebe um endereço próprio
-- no túnel, que passa a ser o endereço pelo qual o RADIUS o reconhece.
create table vpn_settings (
  id boolean primary key default true check (id),          -- linha única
  public_key text not null check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  updated_at timestamptz not null default now()
);
create table vpn_peers (
  device_id uuid primary key references devices(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  tunnel_ip inet not null unique check (masklen(tunnel_ip) = 32),
  public_key text not null unique check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),   -- a chave privada nunca é guardada: aparece uma vez
  last_handshake_at timestamptz,
  endpoint text,
  rx_bytes bigint not null default 0,
  tx_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table vpn_peers enable row level security;
create policy t_vpn on vpn_peers for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_vpn on vpn_peers as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on vpn_peers to nexo_app;
grant select on vpn_settings to nexo_app;

-- O serviço do túnel enxerga os pares de todos os provedores; estas funções devolvem e gravam só o que ele precisa.
create function vpn_peers_all() returns table (public_key text, tunnel_ip text)
  language sql stable security definer set search_path = public as $$
  select p.public_key, host(p.tunnel_ip) from vpn_peers p join tenants t on t.id = p.tenant_id where t.status = 'active' $$;
create function vpn_report(p_public_key text, p_handshake timestamptz, p_endpoint text, p_rx bigint, p_tx bigint) returns void
  language sql security definer set search_path = public as $$
  update vpn_peers set last_handshake_at = p_handshake, endpoint = p_endpoint, rx_bytes = p_rx, tx_bytes = p_tx where public_key = p_public_key $$;
create function vpn_set_server_key(p_public_key text) returns void
  language sql security definer set search_path = public as $$
  insert into vpn_settings (id, public_key) values (true, p_public_key)
  on conflict (id) do update set public_key = excluded.public_key, updated_at = now() where vpn_settings.public_key <> excluded.public_key $$;
-- Próximo endereço livre do túnel (10.250.0.2 em diante; .1 é o servidor). A unicidade é garantida pela restrição; quem chama repete se colidir.
create function vpn_free_ip() returns inet
  language sql stable security definer set search_path = public as $$
  select ('10.250.0.0'::inet + g) from generate_series(2, 65533) g
  where (g % 256) not in (0, 255) and not exists (select 1 from vpn_peers p where p.tunnel_ip = '10.250.0.0'::inet + g) order by g limit 1 $$;
revoke execute on function vpn_peers_all(), vpn_report(text, timestamptz, text, bigint, bigint), vpn_set_server_key(text), vpn_free_ip() from public;
grant execute on function vpn_peers_all(), vpn_report(text, timestamptz, text, bigint, bigint), vpn_set_server_key(text), vpn_free_ip() to nexo_app;
