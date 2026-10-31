-- +goose Up
-- +goose StatementBegin
create table radius_accounting_pending (
 tenant_id uuid not null,
 accounting_id bigint primary key references radius_acct(id) on delete cascade
);
create index radius_accounting_pending_tenant on radius_accounting_pending(tenant_id, accounting_id);
alter table radius_accounting_pending enable row level security;
create policy accounting_pending_tenant on radius_accounting_pending for all to nexo_app
 using (tenant_id=app_tenant()) with check (tenant_id=app_tenant());
create policy accounting_pending_scope on radius_accounting_pending as restrictive for all to nexo_app
 using (app_subscriber() is null and app_pops() is null) with check (app_subscriber() is null and app_pops() is null);
grant select, update, delete on radius_accounting_pending to nexo_app;

create function radius_mark_accounting_pending() returns trigger
 language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.radius_accounting_pending(tenant_id,accounting_id) values(new.tenant_id,new.id)
 on conflict (accounting_id) do update set tenant_id=excluded.tenant_id;
 return new;
end $$;
revoke all on function radius_mark_accounting_pending() from public;
create trigger radius_accounting_pending_mark after insert or update on radius_acct
 for each row execute function radius_mark_accounting_pending();
-- +goose StatementEnd
-- +goose Down
-- +goose StatementBegin
drop trigger radius_accounting_pending_mark on radius_acct;
drop function radius_mark_accounting_pending();
drop table radius_accounting_pending;
-- +goose StatementEnd
