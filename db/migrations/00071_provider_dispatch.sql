-- +goose Up
-- +goose StatementBegin
alter table provider_issuance add column product text not null default 'pix_cob' check(product in ('pix_cob','pix_cobv','bolix')),
 add column product_options jsonb not null default '{}'::jsonb check(jsonb_typeof(product_options)='object'),
 add column attempts integer not null default 0 check(attempts>=0),
 add column next_attempt_at timestamptz not null default now(),
 add column receipt_attempts integer not null default 0,
 add column receipt_next_at timestamptz not null default now(),
 add column receipt_checked_at timestamptz,
 add column receipt_last_error text,
 add column receipt_review boolean not null default false,
 add column last_error text check(last_error in ('provider_unknown','provider_unavailable','provider_rejected','provider_conflict','local_failure'));
grant update(attempts,next_attempt_at,last_error,receipt_attempts,receipt_next_at,receipt_checked_at,receipt_last_error,receipt_review) on provider_issuance to nexo_app;
create index provider_issuance_pending on provider_issuance(tenant_id,next_attempt_at,id) where state in ('prepared','uncertain') and credential_version_id is not null;
create or replace function provider_issuance_guard() returns trigger language plpgsql as $$
declare c financial_connections; i invoices;
begin
 if TG_OP='UPDATE' then
  if (new.tenant_id,new.invoice_id,new.financial_connection_id,new.intent_key,new.request,new.config_hash,new.credential_version_id,new.product,new.product_options)
   is distinct from (old.tenant_id,old.invoice_id,old.financial_connection_id,old.intent_key,old.request,old.config_hash,old.credential_version_id,old.product,old.product_options) then raise exception 'issuance identity is immutable'; end if;
  if new.state=old.state then
   if new.charge_id is distinct from old.charge_id then raise exception 'provider response identity is immutable'; end if;
  elsif not ((old.state='prepared' and new.state='uncertain') or (old.state='uncertain' and new.state in ('issued','review')) or (old.state='review' and new.state='uncertain')) then raise exception 'invalid issuance transition'; end if;
 else
  if new.state<>'prepared' or new.charge_id is not null then raise exception 'issuance must start prepared'; end if;
  select * into c from financial_connections where id=new.financial_connection_id and tenant_id=new.tenant_id;
  if not found or c.provider<>'efi' or c.environment<>'sandbox' or c.status='disabled' then raise exception 'sandbox connection required'; end if;
  select * into i from invoices where id=new.invoice_id and tenant_id=new.tenant_id;
  if not found or i.company_id is distinct from c.company_id then raise exception 'invoice company mismatch'; end if;
 end if;
 new.updated_at=now();return new;
end $$;
-- Activation is still refused by the API without its explicit sandbox gate.
-- Dispatch has a separate default-off gate; no production environment is allowed.
alter table financial_connections drop constraint financial_connections_check;
alter table financial_connections add constraint financial_connections_check check(status<>'active' or
 (provider='demo' and environment='sandbox') or (provider='efi' and environment='sandbox' and credential_version_id is not null));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve provider dispatch configuration and credential identities; reconcile before rollback'; end $$;
-- +goose StatementEnd
