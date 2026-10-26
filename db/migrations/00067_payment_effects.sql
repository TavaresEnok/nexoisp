-- +goose Up
-- +goose StatementBegin
lock table invoices in share row exclusive mode;
alter table invoices add column settlement_version bigint not null default 0;
create table payment_effects (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 invoice_id uuid not null,
 settlement_version bigint not null check(settlement_version>0),
 status text not null default 'pending' check(status in ('pending','planned','ignored')),
 operation_id uuid,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 last_error text,
 outcome text,
 created_at timestamptz not null default now(),
 processed_at timestamptz,
 unique(tenant_id,invoice_id,settlement_version),
 foreign key(tenant_id,invoice_id) references invoices(tenant_id,id),
 foreign key(tenant_id,operation_id) references operations(tenant_id,id),
 check((status='planned')=(operation_id is not null)),
 check((status='pending')=(processed_at is null))
);
create index payment_effects_due on payment_effects(tenant_id,next_attempt_at,id) where status='pending';
alter table payment_effects enable row level security;
create policy payment_effects_read on payment_effects for select using
 (tenant_id=app_tenant() and app_subscriber() is null and exists(select 1 from invoices i where i.id=invoice_id and i.tenant_id=payment_effects.tenant_id));
create policy payment_effects_worker on payment_effects for update using
 (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null)
 with check(tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
grant select on payment_effects to nexo_app;
grant update(status,operation_id,attempts,next_attempt_at,last_error,outcome,processed_at) on payment_effects to nexo_app;
-- Existing paid invoices receive no retroactive network action.
create function invoice_settlement_version() returns trigger language plpgsql as $$
begin
 if TG_OP='INSERT' then
  -- Inserted paid invoices are historical imports, not a new settlement.
  new.settlement_version=0;
 else
  new.settlement_version=old.settlement_version+case when new.status='paid' and old.status<>'paid' then 1 else 0 end;
 end if;
 return new;
end $$;
revoke all on function invoice_settlement_version() from public;
create trigger invoice_settlement_version before insert or update on invoices for each row execute function invoice_settlement_version();
create function record_payment_effect() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.status='paid' and new.settlement_version<>old.settlement_version then
  insert into public.payment_effects(tenant_id,invoice_id,settlement_version) values(new.tenant_id,new.id,new.settlement_version);
 end if;
 return new;
end $$;
revoke all on function record_payment_effect() from public;
create trigger record_payment_effect after update on invoices for each row execute function record_payment_effect();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve payment effects: pause consumer and reconcile pending/planned intentions before rollback'; end $$;
-- +goose StatementEnd
