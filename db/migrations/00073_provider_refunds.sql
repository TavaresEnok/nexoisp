-- +goose Up
-- +goose StatementBegin
lock table payments in share row exclusive mode;
alter table payments add column provider_refund_id text,
 add column provider_return_id text;
create unique index payments_provider_refund_uq on payments(financial_connection_id,provider_refund_id) where provider_refund_id is not null;
create unique index payments_provider_return_uq on payments(financial_connection_id,provider_return_id) where provider_return_id is not null;
alter table payments add constraint payments_refund_identity_check check(
 (provider_refund_id is null and provider_return_id is null) or
 (provider_refund_id is not null and provider_return_id is not null and kind='reversal' and source<>'manual' and financial_connection_id is not null
  and length(provider_refund_id) between 1 and 64 and length(provider_return_id) between 1 and 64));
-- Keep historical cash rows; manual reversals remain full and unique. Provider
-- partial refunds instead have their own account-scoped remote identity.
drop index payments_one_reversal_uq;
create unique index payments_one_reversal_uq on payments(reversal_of) where reversal_of is not null and source='manual';
create or replace function validate_payment_reversal() returns trigger language plpgsql as $$
declare original payments; prior payments; refunded bigint;
begin
 if new.kind<>'reversal' then
  if new.provider_refund_id is not null or new.provider_return_id is not null then raise exception using errcode='N7301',message='receipt cannot use refund identity'; end if;
  return new;
 end if;
 -- Match ordinary financial lock order, including callers outside the Go service.
 perform 1 from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update;
 select * into original from payments where id=new.reversal_of and tenant_id=new.tenant_id and invoice_id=new.invoice_id and kind='payment';
 if not found then raise exception using errcode='N7301',message='reversal must match original tenant invoice and amount'; end if;
 if new.source='manual' then
  if original.source<>'manual' or original.amount_cents<>new.amount_cents or new.provider_refund_id is not null then
   raise exception using errcode='N7301',message='manual reversal must match original manual receipt in full';
  end if;
  return new;
 end if;
 if original.source='manual' or new.financial_connection_id is null or original.financial_connection_id is distinct from new.financial_connection_id
  or original.gateway is distinct from new.gateway or new.provider_refund_id is null or new.provider_return_id is null then
  raise exception using errcode='N7301',message='provider refund requires original account and remote identity';
 end if;
 if new.paid_at<original.paid_at then raise exception using errcode='N7301',message='provider refund cannot precede receipt'; end if;
 select * into prior from payments where financial_connection_id=new.financial_connection_id and
  (provider_refund_id=new.provider_refund_id or provider_return_id=new.provider_return_id) limit 1;
 if found then
  if row(prior.tenant_id,prior.invoice_id,prior.reversal_of,prior.amount_cents,prior.paid_at,prior.provider_refund_id,prior.provider_return_id)
   is distinct from row(new.tenant_id,new.invoice_id,new.reversal_of,new.amount_cents,new.paid_at,new.provider_refund_id,new.provider_return_id) then
   raise exception using errcode='N7301',message='provider refund identity reused with different facts';
  end if;
  return new; -- INSERT ON CONFLICT handles exact replay, even at the full limit.
 end if;
 select coalesce(sum(amount_cents),0) into refunded from payments where reversal_of=original.id;
 if refunded+new.amount_cents>original.amount_cents then raise exception using errcode='N7301',message='cumulative refunds exceed original receipt'; end if;
 return new;
end $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve partial provider refund identities and cash history; reconcile before code rollback'; end $$;
-- +goose StatementEnd
