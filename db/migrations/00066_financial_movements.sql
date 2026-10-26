-- +goose Up
-- +goose StatementBegin
-- Shadow ledger: existing signed payments remain the single cash source.
-- Historical balances are explicit opening snapshots, not invented event history.
-- Prevent a writer from changing a balance between snapshot and trigger install.
lock table invoices,payments,agreements in share row exclusive mode;
create table invoice_movements (
 id bigint generated always as identity primary key,
 tenant_id uuid not null,
 invoice_id uuid not null,
 origin text not null check (origin in ('opening','created','adjustment')),
 nominal_delta bigint not null,
 fee_delta bigint not null,
 discount_delta bigint not null,
 status_after text not null check(status_after in ('open','paid','reconciling','canceled')),
 recorded_at timestamptz not null default now(),
 foreign key (tenant_id,invoice_id) references invoices(tenant_id,id)
);
create index invoice_movements_invoice on invoice_movements(tenant_id,invoice_id,id);
create unique index invoice_movements_opening on invoice_movements(invoice_id) where origin in ('opening','created');
alter table invoice_movements enable row level security;
create policy movements_visible on invoice_movements for select using
 (tenant_id=app_tenant() and exists(select 1 from invoices i where i.id=invoice_id and i.tenant_id=invoice_movements.tenant_id));
grant select on invoice_movements to nexo_app;
insert into invoice_movements(tenant_id,invoice_id,origin,nominal_delta,fee_delta,discount_delta,status_after)
 select tenant_id,id,'opening',amount_cents,fee_cents,discount_cents,status from invoices;

create function record_invoice_movement() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if TG_OP='INSERT' then
  insert into public.invoice_movements(tenant_id,invoice_id,origin,nominal_delta,fee_delta,discount_delta,status_after)
   values(new.tenant_id,new.id,'created',new.amount_cents,new.fee_cents,new.discount_cents,new.status);
 else
  if (new.tenant_id,new.id,new.contract_id,new.subscriber_id) is distinct from (old.tenant_id,old.id,old.contract_id,old.subscriber_id) then
   raise exception 'financial invoice identity is immutable';
  end if;
  if (new.amount_cents,new.fee_cents,new.discount_cents,new.status) is distinct from (old.amount_cents,old.fee_cents,old.discount_cents,old.status) then
   insert into public.invoice_movements(tenant_id,invoice_id,origin,nominal_delta,fee_delta,discount_delta,status_after)
    values(new.tenant_id,new.id,'adjustment',new.amount_cents::bigint-old.amount_cents,new.fee_cents::bigint-old.fee_cents,new.discount_cents::bigint-old.discount_cents,new.status);
  end if;
 end if;
 return new;
end $$;
revoke all on function record_invoice_movement() from public;
create trigger invoice_movement_record after insert or update on invoices for each row execute function record_invoice_movement();

create function financial_append_only() returns trigger language plpgsql as $$
begin raise exception 'financial history is append-only';end $$;
revoke all on function financial_append_only() from public;
create trigger immutable_invoice_movements before update or delete on invoice_movements for each row execute function financial_append_only();
-- Payments already are insert-only for nexo_app. Make the invariant explicit
-- and validate reversal allocation against the original receipt for new rows.
create trigger immutable_payments before update or delete on payments for each row execute function financial_append_only();
create function validate_payment_reversal() returns trigger language plpgsql as $$
begin
 if new.kind='reversal' and not exists(select 1 from payments p where p.id=new.reversal_of and p.tenant_id=new.tenant_id and p.invoice_id=new.invoice_id and p.kind='payment' and p.amount_cents=new.amount_cents) then
  raise exception 'reversal must match original tenant invoice and amount';
 end if;
 return new;
end $$;
revoke all on function validate_payment_reversal() from public;
create trigger payment_reversal_binding before insert on payments for each row execute function validate_payment_reversal();

-- One existing payment is one allocation, including its signed reversal.
-- No second cash ledger or arbitrary redistribution of historical receipts.
create view financial_payment_allocations with (security_invoker=true) as
 select p.id as payment_id,p.tenant_id,p.invoice_id,p.signed_cents::bigint as allocated_cents,p.kind,p.reversal_of,p.financial_connection_id,p.paid_at
 from payments p join invoices i on i.id=p.invoice_id and i.tenant_id=p.tenant_id;
grant select on financial_payment_allocations to nexo_app;

create table agreement_sources (
 tenant_id uuid not null,
 agreement_id uuid not null,
 invoice_id uuid not null,
 nominal_cents bigint not null,
 fee_cents bigint not null,
 discount_cents bigint not null,
 received_cents bigint not null,
 transferred_cents bigint not null check(transferred_cents>0),
 recorded_at timestamptz not null default now(),
 primary key(agreement_id,invoice_id),
 unique(invoice_id),
 foreign key(tenant_id,agreement_id) references agreements(tenant_id,id),
 foreign key(tenant_id,invoice_id) references invoices(tenant_id,id),
 check(transferred_cents=nominal_cents+fee_cents-discount_cents-received_cents)
);
alter table agreement_sources enable row level security;
create policy agreement_sources_visible on agreement_sources for all using
 (tenant_id=app_tenant() and exists(select 1 from invoices i where i.id=invoice_id and i.tenant_id=agreement_sources.tenant_id))
 with check (tenant_id=app_tenant() and exists(select 1 from invoices i join agreements a on a.id=agreement_sources.agreement_id and a.tenant_id=i.tenant_id and a.contract_id=i.contract_id where i.id=agreement_sources.invoice_id));
grant select,insert on agreement_sources to nexo_app;
create trigger immutable_agreement_sources before update or delete on agreement_sources for each row execute function financial_append_only();
-- Old agreements have no proven source mapping; expose rather than infer it.
create view financial_agreement_shadow with(security_invoker=true) as
 select a.id,a.tenant_id,a.original_cents,a.total_cents,a.discount_cents,
 coalesce(s.transferred_cents,0) as source_cents,coalesce(i.installment_cents,0) as installment_cents,
 s.transferred_cents is null as source_unproven,
 (s.transferred_cents=a.original_cents and i.installment_cents=a.total_cents and a.total_cents::bigint=a.original_cents::bigint-a.discount_cents) is true as matches
 from agreements a
 left join (select agreement_id,sum(transferred_cents)::bigint as transferred_cents from agreement_sources group by agreement_id) s on s.agreement_id=a.id
 left join (select agreement_id,sum(amount_cents)::bigint as installment_cents from invoices group by agreement_id) i on i.agreement_id=a.id
 where exists(select 1 from contracts c where c.id=a.contract_id and c.tenant_id=a.tenant_id);
grant select on financial_agreement_shadow to nexo_app;

create view financial_balance_shadow with (security_invoker=true) as
 select x.*,greatest(0,nominal_cents+fee_cents-discount_cents-received_cents) as residual_cents,
 greatest(0,received_cents-(nominal_cents+fee_cents-discount_cents)) as excess_cents,
 case when status='canceled' then 0 else greatest(0,nominal_cents+fee_cents-discount_cents-received_cents) end as collectible_cents,
 (nominal_cents=legacy_nominal_cents and fee_cents=legacy_fee_cents and discount_cents=legacy_discount_cents and received_cents=legacy_received_cents and status=legacy_status) is true as matches
 from (
 select i.id as invoice_id,i.tenant_id,i.company_id,i.contract_id,m.last_status as status,i.status as legacy_status,
 m.nominal_cents,m.fee_cents,m.discount_cents,coalesce(p.received_cents,0)::bigint as received_cents,
 i.amount_cents::bigint as legacy_nominal_cents,i.fee_cents::bigint as legacy_fee_cents,i.discount_cents::bigint as legacy_discount_cents,
 (select coalesce(sum(p0.signed_cents),0)::bigint from payments p0 where p0.invoice_id=i.id and p0.tenant_id=i.tenant_id) as legacy_received_cents
 from invoices i
 left join (select tenant_id,invoice_id,sum(nominal_delta)::bigint nominal_cents,sum(fee_delta)::bigint fee_cents,sum(discount_delta)::bigint discount_cents,(array_agg(status_after order by id desc))[1] as last_status from invoice_movements group by tenant_id,invoice_id) m on m.invoice_id=i.id and m.tenant_id=i.tenant_id
 left join (select tenant_id,invoice_id,sum(allocated_cents)::bigint received_cents from financial_payment_allocations group by tenant_id,invoice_id) p on p.invoice_id=i.id and p.tenant_id=i.tenant_id
 ) x;
grant select on financial_balance_shadow to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve financial movements and agreement sources: reconcile before retiring migration 66'; end $$;
-- +goose StatementEnd
