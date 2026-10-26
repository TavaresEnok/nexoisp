-- +goose Up
-- +goose StatementBegin
-- Private counter: only a valid session can consume a bucket. No direct grants.
create table panel_session_rate (
  token_hash text primary key references sessions(token_hash) on delete cascade on update cascade,
  bucket timestamptz not null,
  calls integer not null check (calls > 0)
);
alter table panel_session_rate enable row level security;

create function nexo_panel_rate_take(p_hash text, p_limit integer)
returns table(calls integer, retry_after integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_limit < 1 or p_limit > 1000000 then raise exception 'limite inválido'; end if;
  return query
  insert into public.panel_session_rate as rate(token_hash, bucket, calls)
  select s.token_hash, date_trunc('minute',now()), 1
  from public.sessions s join public.users u on u.id=s.user_id
  where s.token_hash=p_hash and s.expires_at>now() and u.active
  on conflict(token_hash) do update set
    bucket=excluded.bucket,
    calls=case when rate.bucket=excluded.bucket then least(rate.calls+1,p_limit+1) else 1 end
  returning rate.calls, greatest(1,ceil(extract(epoch from date_trunc('minute',now())+interval '1 minute'-now()))::integer);
end $$;
create function nexo_panel_rate_purge() returns void
language sql security definer set search_path = pg_catalog, public as $$
  delete from public.panel_session_rate where bucket < now()-interval '2 hours' $$;
revoke all on function nexo_panel_rate_take(text,integer), nexo_panel_rate_purge() from public;
grant execute on function nexo_panel_rate_take(text,integer), nexo_panel_rate_purge() to nexo_go;
-- +goose StatementEnd
