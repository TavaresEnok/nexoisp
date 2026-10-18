-- +goose Up
-- +goose StatementBegin
-- Limite de tentativas de login no banco: vale para todas as réplicas da API e sobrevive a reinício.
-- Duas chaves por tentativa: o e-mail (impede adivinhar a senha de uma conta) e o endereço de origem (impede varrer vários e-mails).
-- Sem acesso direto da aplicação: só pelas funções abaixo, que não expõem nada além do estado do limite.
create table login_throttle (
  key text primary key,
  fails integer not null default 0,
  until timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table login_throttle enable row level security;   -- sem política e sem grant para nexo_app: só as funções (dono) acessam

-- Janela deslizante: cada falha renova o prazo. Bloqueia quando as falhas dentro do prazo chegam ao limite.
create function login_throttle_blocked(p_key text, p_limit integer) returns integer
  language sql security definer set search_path = public as $$
  select coalesce((select extract(epoch from until - now())::int from login_throttle
                   where key = p_key and fails >= p_limit and until > now()), 0) $$;

create function login_throttle_fail(p_key text, p_window_s integer) returns void
  language sql security definer set search_path = public as $$
  insert into login_throttle (key, fails, until) values (p_key, 1, now() + make_interval(secs => p_window_s))
  on conflict (key) do update
    set fails = case when login_throttle.until > now() then login_throttle.fails + 1 else 1 end,
        until = now() + make_interval(secs => p_window_s), updated_at = now() $$;

create function login_throttle_clear(p_key text) returns void
  language sql security definer set search_path = public as $$
  delete from login_throttle where key = p_key $$;

-- limpeza das linhas vencidas (chamada pela rotina periódica)
create function login_throttle_purge() returns integer
  language sql security definer set search_path = public as $$
  with d as (delete from login_throttle where until < now() - interval '1 hour' returning 1) select count(*)::int from d $$;

revoke execute on function login_throttle_blocked(text, integer), login_throttle_fail(text, integer), login_throttle_clear(text), login_throttle_purge() from public;
grant execute on function login_throttle_blocked(text, integer), login_throttle_fail(text, integer), login_throttle_clear(text), login_throttle_purge() to nexo_app;
-- +goose StatementEnd
