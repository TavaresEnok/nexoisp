-- Endurecimento pré-piloto: certificado do agente fixado por impressão digital (revogação efetiva por certificado).
alter table agents add column cert_fingerprint text, add column cert_pinned_at timestamptz;

drop function agent_auth(text);
create function agent_auth(p_token_hash text) returns table (id uuid, tenant_id uuid, name text, status text, cert_fingerprint text)
  language sql security definer set search_path = public as $$
  select a.id, a.tenant_id, a.name, a.status, a.cert_fingerprint from agents a join tenants t on t.id = a.tenant_id
  where a.token_hash = p_token_hash and t.status = 'active' $$;
revoke execute on function agent_auth(text) from public;
grant execute on function agent_auth(text) to nexo_app;
