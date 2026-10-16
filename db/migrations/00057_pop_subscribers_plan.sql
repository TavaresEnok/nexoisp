-- +goose Up
-- +goose StatementBegin
-- Mantém o predicado por linha (inclusive INSERT ... RETURNING e UPDATE), mas
-- evita planejar suas duas consultas a cada assinante de uma listagem.
-- A busca é sempre pela mesma chave indexada (tenant_id, subscriber_id).
create or replace function subscriber_in_pops(p_subscriber uuid) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, public
set plan_cache_mode = force_generic_plan as $$
declare visible boolean;
begin
  select coalesce(bool_or(k.pop_id is null or coalesce(k.pop_id = any(public.app_pops()), false)), true)
  into visible
  from public.contracts k
  where k.subscriber_id = p_subscriber and k.tenant_id = public.app_tenant();
  return visible;
end $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
create or replace function subscriber_in_pops(p_subscriber uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from contracts k where k.subscriber_id = p_subscriber and k.tenant_id = app_tenant())
      or exists (select 1 from contracts k where k.subscriber_id = p_subscriber and k.tenant_id = app_tenant()
                 and (k.pop_id is null or k.pop_id = any(app_pops()))) $$;
-- +goose StatementEnd
