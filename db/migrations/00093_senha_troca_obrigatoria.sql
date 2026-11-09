-- +goose Up
-- +goose StatementBegin
-- Senha provisória (AD-02): quando o administrador redefine a senha de outro usuário, a próxima sessão
-- só pode trocar a senha. A troca pela própria conta remove a exigência.
alter table users add column password_change_required boolean not null default false;

drop trigger nexo_auth_users on users;
create trigger nexo_auth_users after update of active, role, mfa_enabled, tenant_id, subscriber_id, password_change_required or delete on users
  for each row execute function nexo_auth_notify();

drop function nexo_go_session_get(text);
create function nexo_go_session_get(p_token_hash text) returns table
  (user_id uuid, tenant_id uuid, role text, name text, email text, subscriber_id uuid,
   support_tenant_id uuid, mfa_enabled boolean, expires_at timestamptz, password_change_required boolean)
  language sql security definer set search_path = pg_catalog, public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.subscriber_id,
         s.support_tenant_id, u.mfa_enabled, s.expires_at, u.password_change_required
  from public.sessions s join public.users u on u.id = s.user_id
  left join public.tenants t on t.id = u.tenant_id
  where s.token_hash = p_token_hash and s.expires_at > now() and u.active
    and (t.id is null or t.status = 'active') $$;
revoke all on function nexo_go_session_get(text) from public;
grant execute on function nexo_go_session_get(text) to nexo_go;

create or replace function user_self_update(p_user uuid, p_password_hash text, p_mfa_secret_enc text, p_mfa_enabled boolean) returns void
  language sql security definer set search_path = public as $$
  update users set password_hash = coalesce(p_password_hash, password_hash),
                   password_change_required = case when p_password_hash is null then password_change_required else false end,
                   mfa_secret_enc = case when p_mfa_enabled is false then null else coalesce(p_mfa_secret_enc, mfa_secret_enc) end,
                   mfa_enabled = coalesce(p_mfa_enabled, mfa_enabled)
  where id = p_user $$;

-- Encerra todas as sessões de um usuário da equipe do provedor em escopo; nunca de outro provedor
-- nem de assinantes do portal.
create function user_sessions_revoke(p_user uuid) returns integer
  language sql security definer set search_path = pg_catalog, public as $$
  with d as (
    delete from public.sessions s
    where s.user_id = p_user
      and exists (select 1 from public.users u where u.id = p_user and u.tenant_id = public.app_tenant() and u.role <> 'subscriber')
    returning 1)
  select count(*)::int from d $$;
revoke execute on function user_sessions_revoke(uuid) from public;
grant execute on function user_sessions_revoke(uuid) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop function user_sessions_revoke(uuid);
create or replace function user_self_update(p_user uuid, p_password_hash text, p_mfa_secret_enc text, p_mfa_enabled boolean) returns void
  language sql security definer set search_path = public as $$
  update users set password_hash = coalesce(p_password_hash, password_hash),
                   mfa_secret_enc = case when p_mfa_enabled is false then null else coalesce(p_mfa_secret_enc, mfa_secret_enc) end,
                   mfa_enabled = coalesce(p_mfa_enabled, mfa_enabled)
  where id = p_user $$;
drop function nexo_go_session_get(text);
create function nexo_go_session_get(p_token_hash text) returns table
  (user_id uuid, tenant_id uuid, role text, name text, email text, subscriber_id uuid,
   support_tenant_id uuid, mfa_enabled boolean, expires_at timestamptz)
  language sql security definer set search_path = pg_catalog, public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.subscriber_id,
         s.support_tenant_id, u.mfa_enabled, s.expires_at
  from public.sessions s join public.users u on u.id = s.user_id
  left join public.tenants t on t.id = u.tenant_id
  where s.token_hash = p_token_hash and s.expires_at > now() and u.active
    and (t.id is null or t.status = 'active') $$;
revoke all on function nexo_go_session_get(text) from public;
grant execute on function nexo_go_session_get(text) to nexo_go;
drop trigger nexo_auth_users on users;
create trigger nexo_auth_users after update of active, role, mfa_enabled, tenant_id, subscriber_id or delete on users
  for each row execute function nexo_auth_notify();
alter table users drop column password_change_required;
-- +goose StatementEnd
