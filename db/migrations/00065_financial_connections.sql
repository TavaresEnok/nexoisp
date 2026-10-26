-- +goose Up
-- +goose StatementBegin
create table financial_connections (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 company_id uuid,
 provider text not null check(provider in ('demo','efi','asaas','inter','sicredi','mercado_pago','pagbank','stripe','kobana','shipay','tuna')),
 environment text not null check(environment in ('sandbox','production')),
 account_ref text not null check(length(account_ref) between 1 and 120),
 name text not null check(length(name) between 2 and 120),
 status text not null default 'pending' check(status in ('pending','active','disabled')),
 is_default boolean not null default false,
 webhook_secret_enc text,
 legacy_demo boolean not null default false,
 created_at timestamptz not null default now(),
 unique(tenant_id,id),
 unique nulls not distinct(tenant_id,company_id,provider,environment,account_ref),
 foreign key(tenant_id,company_id) references companies(tenant_id,id),
 -- Real adapters are not part of B03. A demo can never run in production.
 check(status <> 'active' or (provider='demo' and environment='sandbox'))
);
create unique index financial_connections_default on financial_connections(tenant_id,company_id,provider,environment) nulls not distinct where is_default;
alter table financial_connections enable row level security;
create policy connection_tenant on financial_connections using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy connection_scope on financial_connections as restrictive for all using(app_subscriber() is null and app_pops() is null);
grant select,insert,update on financial_connections to nexo_app;

alter table invoices add column financial_connection_id uuid,
 add constraint invoices_connection_fk foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id);
alter table payments add column financial_connection_id uuid,
 add constraint payments_connection_fk foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id);
alter table gateway_events add column financial_connection_id uuid,
 add constraint events_connection_fk foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id);
alter table demo_gateway_charges add column financial_connection_id uuid,
 add constraint demo_connection_fk foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id);

-- Only demo has a proven origin. Unknown real accounts are NOT inferred.
insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name,status,is_default,legacy_demo)
 select distinct tenant_id,company_id,'demo','sandbox','legacy-demo','Demonstração local preservada','active',true,true
 from invoices where gateway='demo' and gateway_charge_id is not null;
update invoices i set financial_connection_id=c.id from financial_connections c
 where i.tenant_id=c.tenant_id and i.company_id is not distinct from c.company_id and i.gateway='demo' and i.gateway_charge_id is not null and c.legacy_demo;
update payments p set financial_connection_id=i.financial_connection_id from invoices i
 where p.tenant_id=i.tenant_id and p.invoice_id=i.id and p.gateway=i.gateway and p.gateway_payment_id is not null;
update gateway_events e set financial_connection_id=i.financial_connection_id from invoices i
 where e.tenant_id=i.tenant_id and e.gateway=i.gateway and e.charge_id=i.gateway_charge_id;
update demo_gateway_charges d set financial_connection_id=i.financial_connection_id from invoices i
 where d.tenant_id=i.tenant_id and d.charge_id=i.gateway_charge_id and i.gateway='demo';

create view financial_connection_pending with (security_invoker=true) as
 select * from (select 'invoice'::text as entity,id::text as id,tenant_id,gateway as provider,'account_not_proven'::text as reason from invoices where gateway_charge_id is not null and financial_connection_id is null
 union all select 'payment',id::text,tenant_id,gateway,'account_not_proven' from payments where gateway_payment_id is not null and financial_connection_id is null
 union all select 'event',id::text,tenant_id,gateway,'account_not_proven' from gateway_events where financial_connection_id is null
 union all select 'demo_charge',charge_id,tenant_id,'demo','invoice_not_found' from demo_gateway_charges where financial_connection_id is null) pending where app_subscriber() is null and app_pops() is null;
grant select on financial_connection_pending to nexo_app;

-- Build and validate scoped keys before replacing old keys. Unbound historical
-- rows retain their old uniqueness in quarantine; no financial rows are deleted.
create unique index invoices_connection_charge_uq on invoices(financial_connection_id,gateway_charge_id) where financial_connection_id is not null and gateway_charge_id is not null;
create unique index payments_connection_payment_uq on payments(financial_connection_id,gateway_payment_id) where financial_connection_id is not null and gateway_payment_id is not null;
create unique index events_connection_event_uq on gateway_events(financial_connection_id,event_id) where financial_connection_id is not null;
create unique index demo_connection_charge_uq on demo_gateway_charges(financial_connection_id,charge_id) where financial_connection_id is not null;
create unique index invoices_charge_unbound_uq on invoices(gateway,gateway_charge_id) where financial_connection_id is null and gateway_charge_id is not null;
create unique index payments_gateway_unbound_uq on payments(gateway,gateway_payment_id) where financial_connection_id is null and gateway_payment_id is not null;
create unique index events_gateway_unbound_uq on gateway_events(gateway,event_id) where financial_connection_id is null;
create unique index demo_charge_unbound_uq on demo_gateway_charges(charge_id) where financial_connection_id is null;
drop index invoices_charge_uq;
drop index payments_gateway_uq;
alter table gateway_events drop constraint gateway_events_gateway_event_id_key;
alter table demo_gateway_charges drop constraint demo_gateway_charges_pkey;
alter table demo_gateway_charges add column id uuid not null default gen_random_uuid() primary key;

-- Match connection identity on new/changed bindings. Unbound historical rows
-- remain readable but cannot acquire fresh gateway identifiers without review.
create function financial_binding_guard() returns trigger language plpgsql as $$
declare c financial_connections; i invoices;
begin
 if tg_op='UPDATE' and old.financial_connection_id is not null and
    new.financial_connection_id is distinct from old.financial_connection_id then
  raise exception 'financial connection is immutable';
 end if;
 if new.financial_connection_id is null then
  if tg_table_name='invoices' then
   if new.gateway_charge_id is not null and (tg_op='INSERT' or new.gateway_charge_id is distinct from old.gateway_charge_id) then raise exception 'financial connection required'; end if;
  elsif tg_table_name='payments' then
   if new.gateway_payment_id is not null then raise exception 'financial connection required'; end if;
  else raise exception 'financial connection required';
  end if;
  return new;
 end if;
 select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
 if not found then raise exception 'financial connection not visible'; end if;
 if tg_table_name='invoices' then
  if c.provider<>new.gateway or c.company_id is distinct from new.company_id then raise exception 'connection company/provider mismatch'; end if;
 elsif tg_table_name='payments' then
  select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id;
  if not found or i.financial_connection_id is distinct from c.id or new.gateway<>c.provider then raise exception 'payment connection mismatch'; end if;
 elsif tg_table_name='gateway_events' then
  if c.provider<>new.gateway then raise exception 'event provider mismatch'; end if;
 end if;
 return new;
end $$;
create trigger invoices_connection_guard before insert or update of financial_connection_id,gateway,gateway_charge_id,company_id on invoices for each row execute function financial_binding_guard();
create trigger payments_connection_guard before insert on payments for each row execute function financial_binding_guard();
create trigger events_connection_guard before insert or update of financial_connection_id on gateway_events for each row execute function financial_binding_guard();
create trigger demo_connection_guard before insert on demo_gateway_charges for each row execute function financial_binding_guard();

-- Identity cannot change after provisioning; rotate status/secret separately.
create function financial_connection_identity_guard() returns trigger language plpgsql as $$
begin
 if row(new.tenant_id,new.company_id,new.provider,new.environment,new.account_ref,new.legacy_demo) is distinct from row(old.tenant_id,old.company_id,old.provider,old.environment,old.account_ref,old.legacy_demo) then raise exception 'connection identity is immutable'; end if;
 return new;
end $$;
create trigger connection_identity_guard before update on financial_connections for each row execute function financial_connection_identity_guard();

-- Narrow directory lookup for authenticating a connection webhook. Never exposed
-- as an HTTP response. Existing gateway-wide lookup/inbox functions fail closed.
create function financial_connection_lookup(p_id uuid) returns table(tenant_id uuid,id uuid,provider text,environment text,status text,webhook_secret_enc text,legacy_demo boolean)
 language sql security definer set search_path=public,pg_temp as $$
 select tenant_id,id,provider,environment,status,webhook_secret_enc,legacy_demo from financial_connections where id=p_id $$;
revoke all on function financial_connection_lookup(uuid) from public;
grant execute on function financial_connection_lookup(uuid) to nexo_app;
revoke execute on function gateway_charge_tenant(text,text),gateway_event_unmatched(text,text,text,text,jsonb) from nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve connections and scoped financial IDs: suspend writes and reconcile before rollback'; end $$;
-- +goose StatementEnd
