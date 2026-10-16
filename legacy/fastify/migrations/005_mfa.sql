-- E6: MFA (TOTP) para contas administrativas.
alter table users add column mfa_secret_enc text, add column mfa_enabled boolean not null default false;

drop function auth_find_user(text);
create function auth_find_user(p_email text) returns table
  (id uuid, tenant_id uuid, role text, name text, email text, password_hash text, active boolean, subscriber_id uuid, tenant_status text,
   mfa_enabled boolean, mfa_secret_enc text)
  language sql security definer set search_path = public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.password_hash, u.active, u.subscriber_id, t.status, u.mfa_enabled, u.mfa_secret_enc
  from users u left join tenants t on t.id = u.tenant_id where lower(u.email) = lower(p_email) $$;

drop function session_get(text);
create function session_get(p_token_hash text) returns table
  (user_id uuid, tenant_id uuid, role text, name text, email text, subscriber_id uuid, support_tenant_id uuid, mfa_enabled boolean)
  language sql security definer set search_path = public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.subscriber_id, s.support_tenant_id, u.mfa_enabled
  from sessions s join users u on u.id = s.user_id
  left join tenants t on t.id = u.tenant_id
  where s.token_hash = p_token_hash and s.expires_at > now() and u.active
    and (t.id is null or t.status = 'active') $$;

-- o próprio usuário gerencia senha/MFA sem depender das políticas de tenant
create function user_self_update(p_user uuid, p_password_hash text, p_mfa_secret_enc text, p_mfa_enabled boolean) returns void
  language sql security definer set search_path = public as $$
  update users set password_hash = coalesce(p_password_hash, password_hash),
                   mfa_secret_enc = case when p_mfa_enabled is false then null else coalesce(p_mfa_secret_enc, mfa_secret_enc) end,
                   mfa_enabled = coalesce(p_mfa_enabled, mfa_enabled)
  where id = p_user $$;
create function user_self_get(p_user uuid) returns table (password_hash text, mfa_secret_enc text, mfa_enabled boolean)
  language sql security definer set search_path = public as $$
  select password_hash, mfa_secret_enc, mfa_enabled from users where id = p_user $$;
create function sessions_revoke_others(p_user uuid, p_keep text) returns void
  language sql security definer set search_path = public as $$
  delete from sessions where user_id = p_user and token_hash <> p_keep $$;

-- visão de plataforma para o operador do SaaS (contagens, sem dados de clientes)
create function platform_health() returns table (tenant_id uuid, agents integer, agents_offline integer, uncertain integer, failed_recent integer)
  language sql security definer set search_path = public as $$
  select t.id,
    (select count(*)::int from agents a where a.tenant_id = t.id and a.status = 'active'),
    (select count(*)::int from agents a where a.tenant_id = t.id and a.status = 'active' and (a.last_seen_at is null or a.last_seen_at <= now() - interval '30 seconds')),
    (select count(*)::int from operations o where o.tenant_id = t.id and o.status = 'UNCERTAIN'),
    (select count(*)::int from operations o where o.tenant_id = t.id and o.status in ('FAILED','EXPIRED') and o.finished_at > now() - interval '7 days')
  from tenants t where app_is_operator() $$;

revoke execute on function auth_find_user(text), session_get(text), user_self_update(uuid, text, text, boolean), user_self_get(uuid),
  sessions_revoke_others(uuid, text), platform_health() from public;
grant execute on function auth_find_user(text), session_get(text), user_self_update(uuid, text, text, boolean), user_self_get(uuid),
  sessions_revoke_others(uuid, text), platform_health() to nexo_app;
