-- +goose Up
-- +goose StatementBegin
-- Último conjunto de alertas entregue ao destino operacional. Persistido para
-- que reinício ou outra réplica não reenviem o mesmo alerta. Sem grants diretos:
-- acesso só pelas funções abaixo.
create table platform_alert_state (
  id boolean primary key default true check (id),
  last_key text not null,
  sent_at timestamptz not null default now()
);
alter table platform_alert_state enable row level security;

create function nexo_alert_last() returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select last_key from public.platform_alert_state where id $$;
create function nexo_alert_record(p_key text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_key is null or length(p_key) > 1000000 then raise exception 'chave de alerta inválida'; end if;
  insert into public.platform_alert_state(id, last_key, sent_at) values (true, p_key, now())
  on conflict (id) do update set last_key = excluded.last_key, sent_at = excluded.sent_at;
end $$;
revoke all on function nexo_alert_last(), nexo_alert_record(text) from public;
grant execute on function nexo_alert_last(), nexo_alert_record(text) to nexo_go, nexo_app;
-- +goose StatementEnd
-- +goose Down
drop function nexo_alert_record(text);
drop function nexo_alert_last();
drop table platform_alert_state;
