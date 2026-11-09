-- +goose Up
-- +goose StatementBegin
-- Custo médio ponderado do estoque e contas a pagar.
--
-- Custo médio GLOBAL por material (não por depósito): transferências não mudam o
-- custo e a mesma compra pode entrar em qualquer depósito; o valor de cada
-- depósito é o saldo dele multiplicado pelo custo médio do material.
-- Entrada com custo (recebimento de compra ou entrada manual com custo unitário):
--   novo médio = arredonda((saldo × médio + qtd × custo) / (saldo + qtd)), em centavos,
--   meio centavo para cima; com saldo zero o médio passa a ser o custo da entrada.
-- Demais movimentos (saídas, ajustes, transferências, unidades por série, retornos)
-- usam o custo médio vigente e não o alteram. Cada movimento grava o custo
-- unitário aplicado e o médio resultante.
alter table stock_items add column avg_cost_cents bigint not null default 0 check (avg_cost_cents between 0 and 100000000);
alter table stock_movements add column unit_cost_cents bigint, add column avg_cost_cents bigint, add column cost_source text;

-- Reconstitui o custo dos movimentos existentes: compras recebidas usam o custo do
-- pedido; os demais movimentos, o médio vigente no momento (zero sem compra anterior).
do $$
declare m record; current_item uuid; balance bigint := 0; average bigint := 0; cost bigint; source text;
begin
 for m in select id, item_id, qty, kind, purchase_order_id from stock_movements order by item_id, id loop
  if current_item is distinct from m.item_id then
   if current_item is not null then update stock_items set avg_cost_cents = average where id = current_item; end if;
   current_item := m.item_id; balance := 0; average := 0;
  end if;
  cost := null;
  if m.kind = 'in' and m.purchase_order_id is not null then
   select x.unit_cost_cents into cost from purchase_order_items x where x.order_id = m.purchase_order_id and x.item_id = m.item_id;
  end if;
  if cost is not null then
   average := case when balance <= 0 then cost else round((balance::numeric * average + m.qty::numeric * cost) / (balance + m.qty))::bigint end;
   source := 'entry';
  else
   cost := average; source := 'average';
  end if;
  balance := balance + m.qty;
  update stock_movements set unit_cost_cents = cost, avg_cost_cents = average, cost_source = source where id = m.id;
 end loop;
 if current_item is not null then update stock_items set avg_cost_cents = average where id = current_item; end if;
end $$;
alter table stock_movements alter column unit_cost_cents set not null, alter column avg_cost_cents set not null, alter column cost_source set not null;
alter table stock_movements add constraint stock_movements_cost_check check (unit_cost_cents between 0 and 100000000 and avg_cost_cents between 0 and 100000000 and cost_source in ('entry','average'));

create function stock_movement_cost() returns trigger language plpgsql as $$
declare average bigint; balance bigint;
begin
 select avg_cost_cents into average from stock_items where tenant_id = new.tenant_id and id = new.item_id for update;
 if not found then raise exception 'item de estoque não encontrado' using errcode = 'foreign_key_violation'; end if;
 if new.unit_cost_cents is not null then
  if new.kind <> 'in' or new.qty <= 0 then
   raise exception 'custo unitário só é informado em entradas' using errcode = 'check_violation';
  end if;
  select coalesce(sum(qty), 0) into balance from stock_movements where tenant_id = new.tenant_id and item_id = new.item_id;
  average := case when balance <= 0 then new.unit_cost_cents
   else round((balance::numeric * average + new.qty::numeric * new.unit_cost_cents) / (balance + new.qty))::bigint end;
  update stock_items set avg_cost_cents = average where tenant_id = new.tenant_id and id = new.item_id;
  new.cost_source := 'entry';
 else
  new.unit_cost_cents := average;
  new.cost_source := 'average';
 end if;
 new.avg_cost_cents := average;
 return new;
end $$;
revoke all on function stock_movement_cost() from public;
create trigger stock_movement_cost before insert on stock_movements for each row execute function stock_movement_cost();

-- Contas a pagar: títulos gerados pelo recebimento de compra ou lançados à mão.
create table payables (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
 number integer not null check (number > 0),
 supplier_id uuid, purchase_order_id uuid,
 description text not null check (char_length(description) between 3 and 200 and description = btrim(description)),
 installment smallint not null default 1, installments smallint not null default 1,
 amount_cents bigint not null check (amount_cents > 0),
 due_date date not null,
 status text not null default 'open' check (status in ('open','paid','canceled')),
 paid_on date, paid_method text check (paid_method in ('pix','boleto','transfer','cash','card','other')),
 paid_note text not null default '' check (char_length(paid_note) <= 300), paid_at timestamptz, paid_by uuid references users(id),
 canceled_at timestamptz, canceled_by uuid references users(id), cancel_reason text check (char_length(cancel_reason) between 5 and 300),
 created_by uuid references users(id), created_at timestamptz not null default now(),
 unique (tenant_id,id), unique (tenant_id,number),
 foreign key (tenant_id,supplier_id) references suppliers(tenant_id,id),
 foreign key (tenant_id,purchase_order_id) references purchase_orders(tenant_id,id),
 check (installments between 1 and 24 and installment between 1 and installments),
 check (purchase_order_id is null or supplier_id is not null),
 check ((status = 'paid') = (paid_on is not null) and (paid_on is null) = (paid_method is null) and (paid_on is null) = (paid_at is null)),
 check ((status = 'canceled') = (canceled_at is not null) and (canceled_at is null) = (cancel_reason is null))
);
create unique index payables_purchase_installment on payables(tenant_id,purchase_order_id,installment) where purchase_order_id is not null;
create index payables_due on payables(tenant_id,status,due_date,id);
create index payables_supplier on payables(tenant_id,supplier_id,due_date) where supplier_id is not null;
-- Título baixado ou cancelado não volta nem muda de valor.
create function payable_guard() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then raise exception 'título a pagar não é apagado; cancele-o' using errcode = 'check_violation'; end if;
 if (new.tenant_id, new.number, new.supplier_id, new.purchase_order_id, new.description, new.installment, new.installments, new.amount_cents, new.due_date, new.created_at)
    is distinct from (old.tenant_id, old.number, old.supplier_id, old.purchase_order_id, old.description, old.installment, old.installments, old.amount_cents, old.due_date, old.created_at) then
  raise exception 'título a pagar %: dados do lançamento são imutáveis', old.number using errcode = 'check_violation';
 end if;
 if old.status <> 'open' then
  raise exception 'título a pagar % já está %', old.number, case old.status when 'paid' then 'pago' else 'cancelado' end using errcode = 'check_violation';
 end if;
 return new;
end $$;
revoke all on function payable_guard() from public;
create trigger payable_guard before update or delete on payables for each row execute function payable_guard();
alter table payables enable row level security;
create policy tenant_scope on payables for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_scope on payables as restrictive for all using (app_subscriber() is null and app_pops() is null) with check (app_subscriber() is null and app_pops() is null);
grant select, insert, update on payables to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop table payables;
drop function payable_guard();
drop trigger stock_movement_cost on stock_movements;
drop function stock_movement_cost();
alter table stock_movements drop constraint stock_movements_cost_check;
alter table stock_movements drop column cost_source, drop column avg_cost_cents, drop column unit_cost_cents;
alter table stock_items drop column avg_cost_cents;
-- +goose StatementEnd
