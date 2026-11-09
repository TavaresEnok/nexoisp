-- +goose Up
-- +goose StatementBegin
-- Consulta pública de viabilidade por provedor. A configuração fica no painel; a página pública só
-- recebe "atendemos/não atendemos", nunca posição, quantidade ou ocupação das caixas.
create table viability_settings (
  tenant_id uuid primary key references tenants(id),
  enabled boolean not null default false,
  radius_m integer not null default 250 check (radius_m between 50 and 2000),
  message text check (message is null or (char_length(message) between 2 and 500 and message = btrim(message))),
  phone text check (phone is null or phone ~ '^[0-9+() -]{8,20}$'),
  whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$'),
  create_lead boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table viability_settings enable row level security;
create policy viability_read on viability_settings for select using (tenant_id = app_tenant() and app_subscriber() is null);
create policy viability_insert on viability_settings for insert with check (tenant_id = app_tenant() and app_subscriber() is null and app_pops() is null);
create policy viability_update on viability_settings for update using (tenant_id = app_tenant() and app_subscriber() is null and app_pops() is null) with check (tenant_id = app_tenant() and app_subscriber() is null and app_pops() is null);
grant select, insert, update on viability_settings to nexo_app;

-- Resolve o identificador público sem expor provedores: inexistente, suspenso, sem FTTH ou com a consulta
-- desativada devolvem zero linhas, igualmente.
create function viability_public_get(p_slug text) returns table
  (tenant_id uuid, name text, logo_sha256 text, radius_m integer, message text, phone text, whatsapp text, lead_capture boolean)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.id, coalesce(b.display_name, t.name), b.logo_sha256, v.radius_m, v.message, v.phone, v.whatsapp,
         v.create_lead and 'crm' = any(t.modules)
  from public.tenants t
  join public.viability_settings v on v.tenant_id = t.id
  left join public.tenant_branding b on b.tenant_id = t.id
  where t.slug = p_slug and t.status = 'active' and v.enabled and 'ftth' = any(t.modules) $$;
revoke execute on function viability_public_get(text) from public;
grant execute on function viability_public_get(text) to nexo_app;

-- Limite por janela fixa para rotas públicas sem sessão (compartilhado entre réplicas). Devolve os
-- segundos de espera quando a chamada excede o limite; zero quando pode prosseguir.
create function public_rate_take(p_key text, p_limit integer, p_window_s integer) returns integer
  language sql security definer set search_path = pg_catalog, public as $$
  with up as (
    insert into public.login_throttle as l (key, fails, until) values (p_key, 1, now() + make_interval(secs => p_window_s))
    on conflict (key) do update
      set fails = case when l.until > now() then l.fails + 1 else 1 end,
          until = case when l.until > now() then l.until else now() + make_interval(secs => p_window_s) end,
          updated_at = now()
    returning fails, until)
  select case when fails > p_limit then greatest(1, ceil(extract(epoch from until - now()))::int) else 0 end from up $$;
revoke execute on function public_rate_take(text, integer, integer) from public;
grant execute on function public_rate_take(text, integer, integer) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop function public_rate_take(text, integer, integer);
drop function viability_public_get(text);
drop table viability_settings;
-- +goose StatementEnd
