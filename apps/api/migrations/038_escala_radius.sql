-- Escala do RADIUS integrado: sincronizar só o que mudou e limpar o histórico antigo.

-- Marca de "visto pelo servidor" (relógio do banco). As datas do accounting vêm do relógio do concentrador e podem chegar atrasadas;
-- por isso a sincronização incremental não pode se guiar por elas.
alter table radius_acct add column seen_at timestamptz not null default clock_timestamp();
create function radius_acct_touch() returns trigger language plpgsql as $$ begin new.seen_at := clock_timestamp(); return new; end $$;
create trigger radius_acct_touch before insert or update on radius_acct for each row execute function radius_acct_touch();
create index radius_acct_seen on radius_acct (tenant_id, seen_at);
create index radius_account_updated on radius_account (tenant_id, updated_at);

-- Limpeza: tentativas de autenticação por idade; sessões encerradas por idade (o registro de conexão deve ser guardado por 1 ano
-- pelo provedor de conexão — Marco Civil da Internet, art. 13 —, então o padrão da aplicação fica acima disso).
create index radius_postauth_at on radius_postauth (tenant_id, at);
create index radius_acct_stopped on radius_acct (tenant_id, stopped_at) where stopped_at is not null;
create index service_sessions_stopped on service_sessions (tenant_id, stopped_at) where stopped_at is not null;
grant delete on radius_acct, radius_postauth, service_sessions to nexo_app;
