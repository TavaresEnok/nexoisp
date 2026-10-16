-- +goose Up
-- +goose StatementBegin
-- Multiempresa: um provedor pode emitir por mais de um CNPJ (matriz, filiais, empresa de outro serviço).
-- O contrato aponta para a empresa que o fatura; a fatura guarda a empresa vigente no momento em que nasce.
-- Sem nenhuma empresa cadastrada, nada muda: o recurso fica invisível.
create table companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 120),
  document text check (document ~ '^[0-9]{14}$'),          -- CNPJ, só dígitos
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create unique index companies_one_default on companies (tenant_id) where is_default;
create unique index companies_document_uq on companies (tenant_id, document) where document is not null;
alter table companies enable row level security;
create policy t_companies on companies for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_companies on companies as restrictive for all using (app_subscriber() is null);
grant select, insert, update on companies to nexo_app;

alter table contracts add column company_id uuid,
  add constraint contracts_company_fk foreign key (tenant_id, company_id) references companies (tenant_id, id);
alter table invoices add column company_id uuid,
  add constraint invoices_company_fk foreign key (tenant_id, company_id) references companies (tenant_id, id);
create index contracts_company on contracts (tenant_id, company_id) where company_id is not null;
create index invoices_company on invoices (tenant_id, company_id, due_date) where company_id is not null;

-- Toda fatura nasce com a empresa do contrato (vale para mensal, avulsa, acordo e importação), sem mexer em cada ponto que insere.
create function invoice_set_company() returns trigger language plpgsql as $$
begin
  if new.company_id is null then
    select coalesce(k.company_id, (select d.id from companies d where d.tenant_id = k.tenant_id and d.is_default and d.active))
      into new.company_id from contracts k where k.id = new.contract_id;
  end if;
  return new;
end $$;
create trigger invoices_company before insert on invoices for each row execute function invoice_set_company();
-- +goose StatementEnd
