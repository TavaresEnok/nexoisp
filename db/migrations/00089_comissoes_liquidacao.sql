-- +goose Up
-- +goose StatementBegin
-- Liquidação de comissões. Cada liquidação congela as linhas apuradas (origem,
-- regra aplicada e valor em centavos) no momento da criação. O relatório passa a
-- ler o valor congelado das liquidações fechadas ou pagas; mudar a regra depois
-- não altera período fechado. A reserva (claims) impede que a mesma origem entre
-- em duas liquidações; o estorno libera a origem sem apagar linhas ou histórico.
create table commission_settlements (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
 number integer not null check (number > 0),
 period_from date not null, period_to date not null,
 competence text check (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 user_id uuid, timezone text not null,
 status text not null default 'open' check (status in ('open','closed','paid','reversed')),
 note text not null default '' check (char_length(note) <= 500),
 created_by uuid references users(id), created_at timestamptz not null default now(),
 closed_at timestamptz, closed_by uuid references users(id),
 paid_on date, paid_method text check (paid_method in ('pix','transfer','cash','payroll','other')),
 paid_note text not null default '' check (char_length(paid_note) <= 500), paid_at timestamptz, paid_by uuid references users(id),
 reversed_at timestamptz,
 unique (tenant_id,id), unique (tenant_id,number),
 foreign key (tenant_id,user_id) references users(tenant_id,id),
 check (period_to >= period_from and period_to - period_from <= 366),
 check ((status = 'open') = (closed_at is null)),
 check ((status = 'reversed') = (reversed_at is not null)),
 check ((paid_at is null) = (paid_on is null) and (paid_on is null) = (paid_method is null)),
 check (status <> 'paid' or paid_on is not null)
);
create table commission_settlement_lines (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
 settlement_id uuid not null, user_id uuid not null, user_name text not null,
 source_kind text not null check (source_kind in ('work_order','sale')), source_id uuid not null,
 role text not null check (role in ('assignee','helper','sale')),
 source_label text not null check (char_length(source_label) <= 200), occurred_at timestamptz not null,
 os_kind text check (os_kind in ('install','repair','address_change','removal','other')),
 rule_id uuid references commission_rules(id), rule_os_kind text,
 amount_cents bigint not null check (amount_cents between 0 and 100000000),
 created_at timestamptz not null default now(),
 unique (tenant_id,id), unique (tenant_id,settlement_id,id),
 foreign key (tenant_id,settlement_id) references commission_settlements(tenant_id,id) on delete cascade,
 foreign key (tenant_id,user_id) references users(tenant_id,id),
 check ((source_kind = 'sale') = (role = 'sale'))
);
create index commission_settlement_lines_settlement on commission_settlement_lines(tenant_id,settlement_id,occurred_at);
create index commission_settlement_lines_period on commission_settlement_lines(tenant_id,occurred_at);
-- Uma origem (OS como responsável, OS como cada auxiliar, venda) pertence a no máximo uma liquidação vigente.
create table commission_settlement_claims (
 tenant_id uuid not null references tenants(id), source_kind text not null, source_id uuid not null, slot text not null,
 settlement_id uuid not null, line_id uuid not null,
 primary key (tenant_id,source_kind,source_id,slot),
 unique (line_id),
 foreign key (tenant_id,settlement_id,line_id) references commission_settlement_lines(tenant_id,settlement_id,id) on delete cascade
);
create index commission_settlement_claims_settlement on commission_settlement_claims(tenant_id,settlement_id);
create table commission_settlement_reversals (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
 settlement_id uuid not null, reason text not null check (char_length(reason) between 5 and 300),
 amount_cents bigint not null check (amount_cents >= 0), was_paid boolean not null,
 created_by uuid references users(id), created_at timestamptz not null default now(),
 unique (tenant_id,settlement_id),
 foreign key (tenant_id,settlement_id) references commission_settlements(tenant_id,id)
);

-- Defesa no banco: período fechado é imutável e só segue as transições previstas.
create function commission_settlement_guard() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then
  if old.status <> 'open' then raise exception 'liquidação % não está aberta', old.number using errcode = 'check_violation'; end if;
  return old;
 end if;
 if (new.tenant_id, new.number, new.period_from, new.period_to, new.competence, new.user_id, new.timezone, new.created_at)
    is distinct from (old.tenant_id, old.number, old.period_from, old.period_to, old.competence, old.user_id, old.timezone, old.created_at) then
  raise exception 'liquidação %: período e abrangência são imutáveis', old.number using errcode = 'check_violation';
 end if;
 if old.status <> 'open' and new.note is distinct from old.note then
  raise exception 'liquidação % fechada não pode ser alterada', old.number using errcode = 'check_violation';
 end if;
 if new.status is distinct from old.status and not (
   (old.status = 'open' and new.status = 'closed') or (old.status = 'closed' and new.status in ('paid','reversed'))
   or (old.status = 'paid' and new.status = 'reversed')) then
  raise exception 'liquidação % não pode passar de % para %', old.number, old.status, new.status using errcode = 'check_violation';
 end if;
 if old.status in ('paid','reversed') and (new.paid_on, new.paid_method, new.paid_note, new.paid_at, new.paid_by)
    is distinct from (old.paid_on, old.paid_method, old.paid_note, old.paid_at, old.paid_by) then
  raise exception 'liquidação %: pagamento registrado é imutável', old.number using errcode = 'check_violation';
 end if;
 return new;
end $$;
revoke all on function commission_settlement_guard() from public;
create trigger commission_settlement_guard before update or delete on commission_settlements for each row execute function commission_settlement_guard();
create function commission_settlement_line_guard() returns trigger language plpgsql as $$
declare current_status text;
begin
 if tg_op = 'UPDATE' then raise exception 'linha de liquidação é imutável' using errcode = 'check_violation'; end if;
 select status into current_status from commission_settlements where tenant_id = old.tenant_id and id = old.settlement_id;
 -- Sem liquidação visível: exclusão em cascata do rascunho, já validada no gatilho da liquidação.
 if current_status is not null and current_status <> 'open' then
  raise exception 'linha de liquidação fechada é imutável' using errcode = 'check_violation';
 end if;
 return old;
end $$;
revoke all on function commission_settlement_line_guard() from public;
create trigger commission_settlement_line_guard before update or delete on commission_settlement_lines for each row execute function commission_settlement_line_guard();
create function commission_reversal_append_only() returns trigger language plpgsql as $$
begin raise exception 'estorno de liquidação é imutável' using errcode = 'check_violation'; end $$;
revoke all on function commission_reversal_append_only() from public;
create trigger commission_reversal_append_only before update or delete on commission_settlement_reversals for each row execute function commission_reversal_append_only();

do $$ declare t text; begin
 foreach t in array array['commission_settlements','commission_settlement_lines','commission_settlement_claims','commission_settlement_reversals'] loop
  execute format('alter table %I enable row level security',t);
  execute format('create policy tenant_scope on %I for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())',t);
  execute format('create policy portal_scope on %I as restrictive for all using (app_subscriber() is null and app_pops() is null) with check (app_subscriber() is null and app_pops() is null)',t);
 end loop;
end $$;
grant select, insert, update, delete on commission_settlements to nexo_app;
grant select, insert, delete on commission_settlement_lines, commission_settlement_claims to nexo_app;
grant select, insert on commission_settlement_reversals to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop table commission_settlement_reversals, commission_settlement_claims, commission_settlement_lines, commission_settlements;
drop function commission_reversal_append_only();
drop function commission_settlement_line_guard();
drop function commission_settlement_guard();
-- +goose StatementEnd
