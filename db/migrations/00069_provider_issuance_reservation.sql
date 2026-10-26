-- +goose Up
-- +goose StatementBegin
-- Serialize migration with existing financial writers. Refuse ambiguous old
-- intentions rather than changing receipts, nominal values or provider identity.
lock table invoices,payments,provider_issuance in share row exclusive mode;
do $$ begin
 if exists(select 1 from provider_issuance j join invoices i on i.id=j.invoice_id and i.tenant_id=j.tenant_id
 join financial_connections c on c.id=j.financial_connection_id and c.tenant_id=j.tenant_id
 where row(j.request->>'invoice_id',j.request->>'intent_key',j.request#>>'{scope,tenant_id}',j.request#>>'{scope,connection_id}',j.request#>>'{scope,provider}',j.request#>>'{scope,environment}',j.request#>>'{scope,account_ref}',j.request#>>'{money,amount_cents}',j.request#>>'{money,currency}',j.request->>'due_date')
 is distinct from row(i.id::text,j.intent_key,i.tenant_id::text,c.id::text,'efi','sandbox',c.account_ref,i.amount_cents::text,'BRL',i.due_date::text)
 or c.provider<>'efi' or c.environment<>'sandbox' or c.company_id is distinct from i.company_id or i.fee_cents<>0 or i.discount_cents<>0
 or not (
  (i.status='open' and i.financial_connection_id is null and i.gateway_charge_id is null and not exists(select 1 from payments p where p.invoice_id=i.id))
  or (j.state='issued' and i.financial_connection_id=j.financial_connection_id and i.gateway_charge_id=j.charge_id and i.gateway='efi' and i.status<>'canceled')
 )) then raise exception 'Existing issuance differs from invoice/account: reconcile at version 68 before upgrade'; end if;
end $$;

alter table provider_issuance add constraint provider_issuance_tenant_id_uq unique(tenant_id,id);
alter table invoices add column provider_issuance_id uuid,
 add constraint invoices_issuance_fk foreign key(tenant_id,provider_issuance_id) references provider_issuance(tenant_id,id);
update invoices i set provider_issuance_id=j.id from provider_issuance j where j.invoice_id=i.id and j.tenant_id=i.tenant_id;
-- An already issued legacy intention has a proven response but not yet a binding.
-- Binding changes neither status nor money. Ambiguous rows were rejected above.
update invoices i set financial_connection_id=j.financial_connection_id,gateway='efi',gateway_charge_id=j.charge_id
 from provider_issuance j where i.provider_issuance_id=j.id and j.state='issued' and i.gateway_charge_id is null;

create function provider_issuance_reserve() returns trigger language plpgsql as $$
declare i invoices; c financial_connections;
begin
 -- Match payment/update order: invoice first, journal second.
 select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
 if not found then raise exception using errcode='42501',message='invoice not visible'; end if;
 select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
 if not found then raise exception using errcode='42501',message='connection not visible'; end if;
 if row(new.request->>'invoice_id',new.request->>'intent_key',new.request#>>'{scope,tenant_id}',new.request#>>'{scope,connection_id}',new.request#>>'{scope,provider}',new.request#>>'{scope,environment}',new.request#>>'{scope,account_ref}',new.request#>>'{money,amount_cents}',new.request#>>'{money,currency}',new.request->>'due_date')
 is distinct from row(i.id::text,new.intent_key,i.tenant_id::text,c.id::text,'efi','sandbox',c.account_ref,i.amount_cents::text,'BRL',i.due_date::text)
 or c.company_id is distinct from i.company_id or c.provider<>'efi' or c.environment<>'sandbox' or c.status='disabled'
 or i.provider_issuance_id is not null or i.status<>'open' or i.amount_cents<=0 or i.fee_cents<>0 or i.discount_cents<>0 or i.financial_connection_id is not null or i.gateway_charge_id is not null
 or exists(select 1 from payments p where p.invoice_id=i.id) then
  raise exception using errcode='N6901',message='invoice is not eligible for a new frozen issuance';
 end if;
 return new;
end $$;
revoke all on function provider_issuance_reserve() from public;
create trigger provider_issuance_reserve before insert on provider_issuance for each row execute function provider_issuance_reserve();

create function provider_issuance_reservation_link() returns trigger language plpgsql as $$
begin
 update invoices set provider_issuance_id=new.id where tenant_id=new.tenant_id and id=new.invoice_id;
 return new;
end $$;
revoke all on function provider_issuance_reservation_link() from public;
create trigger provider_issuance_reservation_link after insert on provider_issuance for each row execute function provider_issuance_reservation_link();

create function invoice_issuance_guard() returns trigger language plpgsql as $$
declare j provider_issuance;
begin
 if TG_OP='DELETE' then
  if old.provider_issuance_id is not null then raise exception using errcode='N6901',message='provider issuance history must be preserved'; end if;
  return old;
 end if;
 if old.provider_issuance_id is null and new.provider_issuance_id is null then return new; end if;
 if old.provider_issuance_id is not null and new.provider_issuance_id is distinct from old.provider_issuance_id then
  raise exception using errcode='N6901',message='provider issuance reservation is immutable';
 end if;
 -- Ordinary payments after binding must not require journal/account access:
 -- POP-limited operators may see the invoice while RLS hides the journal.
 if old.provider_issuance_id is null then
  select * into j from provider_issuance where id=new.provider_issuance_id and invoice_id=old.id and tenant_id=old.tenant_id;
  if not found then raise exception using errcode='N6901',message='provider issuance reservation not visible'; end if;
 end if;
 -- These are the financial fields sent to the PSP or defining debt ownership.
 if row(new.tenant_id,new.contract_id,new.subscriber_id,new.amount_cents,new.due_date,new.fee_cents,new.discount_cents,new.company_id,new.agreement_id)
 is distinct from row(old.tenant_id,old.contract_id,old.subscriber_id,old.amount_cents,old.due_date,old.fee_cents,old.discount_cents,old.company_id,old.agreement_id)
 or (new.status='canceled' and old.status<>'canceled') then
  raise exception using errcode='N6901',message='provider charge must be reconciled/canceled before changing debt';
 end if;
 if old.gateway_charge_id is null then
  if new.status is distinct from old.status then raise exception using errcode='N6901',message='provider issuance result is pending'; end if;
  if row(new.financial_connection_id,new.gateway,new.gateway_charge_id) is distinct from row(old.financial_connection_id,old.gateway,old.gateway_charge_id) then
   select * into j from provider_issuance where id=new.provider_issuance_id and invoice_id=old.id and tenant_id=old.tenant_id;
   if not found then raise exception using errcode='N6901',message='provider issuance reservation not visible'; end if;
   if j.state<>'issued' or new.financial_connection_id is distinct from j.financial_connection_id or new.gateway is distinct from 'efi' or new.gateway_charge_id is distinct from j.charge_id then
    raise exception using errcode='N6901',message='only the confirmed provider response can bind the invoice';
   end if;
  end if;
 else
  if row(new.financial_connection_id,new.gateway,new.gateway_charge_id) is distinct from row(old.financial_connection_id,old.gateway,old.gateway_charge_id) then
   raise exception using errcode='N6901',message='confirmed provider charge identity is immutable';
  end if;
 end if;
 return new;
end $$;
revoke all on function invoice_issuance_guard() from public;
create trigger a_invoice_issuance_guard before update or delete on invoices for each row execute function invoice_issuance_guard();

create function provider_issuance_bind() returns trigger language plpgsql as $$
begin
 if new.state='issued' and old.state<>'issued' then
  update invoices set financial_connection_id=new.financial_connection_id,gateway='efi',gateway_charge_id=new.charge_id
   where id=new.invoice_id and tenant_id=new.tenant_id and provider_issuance_id=new.id;
  if not found then raise exception using errcode='N6901',message='provider issuance reservation missing'; end if;
 end if;
 return new;
end $$;
revoke all on function provider_issuance_bind() from public;
create trigger provider_issuance_bind after update on provider_issuance for each row execute function provider_issuance_bind();

create function provider_issuance_payment_guard() returns trigger language plpgsql as $$
declare i invoices;
begin
 select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
 if not found then raise exception using errcode='42501',message='invoice not visible'; end if;
 if i.provider_issuance_id is not null and i.gateway_charge_id is null then
  raise exception using errcode='N6901',message='payment requires reconciliation of pending provider issuance';
 end if;
 return new;
end $$;
revoke all on function provider_issuance_payment_guard() from public;
create trigger a_provider_issuance_payment_guard before insert on payments for each row execute function provider_issuance_payment_guard();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve issuance reservations and bindings; reconcile provider outcomes before code rollback'; end $$;
-- +goose StatementEnd
