-- +goose Up
-- +goose StatementBegin
-- Interface adicional: o Fastify continua usando session_get(text), inalterada.
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

create function nexo_auth_notify() returns trigger language plpgsql
  set search_path = pg_catalog, public as $$
declare r record; previous record; payload jsonb;
begin
  if TG_OP = 'DELETE' then r := old; else r := new; end if;
  if TG_TABLE_NAME = 'sessions' then
    payload := jsonb_build_object('k','session','h',r.token_hash);
    if TG_OP = 'UPDATE' and old.token_hash is distinct from new.token_hash then
      perform pg_notify('nexo_auth', jsonb_build_object('k','session','h',old.token_hash,'at',clock_timestamp())::text);
    end if;
  elsif TG_TABLE_NAME = 'tenants' then
    payload := jsonb_build_object('k','tenant','t',r.id);
  else
    if TG_TABLE_NAME = 'user_pops' then
      payload := jsonb_build_object('k','user','u',r.user_id);
      if TG_OP = 'UPDATE' and old.user_id is distinct from new.user_id then
        perform pg_notify('nexo_auth', jsonb_build_object('k','user','u',old.user_id,'at',clock_timestamp())::text);
      end if;
    else
      payload := jsonb_build_object('k','user','u',r.id);
    end if;
  end if;
  perform pg_notify('nexo_auth', (payload || jsonb_build_object('at',clock_timestamp()))::text);
  return r;
end $$;
revoke all on function nexo_auth_notify() from public;
create trigger nexo_auth_sessions after update or delete on sessions for each row execute function nexo_auth_notify();
create trigger nexo_auth_users after update of active, role, mfa_enabled, tenant_id, subscriber_id or delete on users for each row execute function nexo_auth_notify();
create trigger nexo_auth_tenants after update of status, modules or delete on tenants for each row execute function nexo_auth_notify();
create trigger nexo_auth_user_pops after insert or update or delete on user_pops for each row execute function nexo_auth_notify();
-- +goose StatementEnd
