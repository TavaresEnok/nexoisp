-- +goose Up
-- +goose StatementBegin
-- Templates de provisionamento TR-069 do provedor. Valem para todo o provedor:
-- a leitura segue o escopo da equipe; a escrita exige sessão sem restrição de
-- POP. Senhas nunca ficam no template: parâmetros de senha só aceitam as
-- variáveis {{pppoe_senha}} e {{wifi_senha}}, resolvidas na aplicação e
-- guardadas apenas no envelope cifrado da intenção ACS.
create table acs_templates (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references tenants(id),
 name text not null check(char_length(name) between 2 and 120 and name=btrim(name)),
 manufacturer text not null default '*' check(char_length(manufacturer) between 1 and 100 and manufacturer=btrim(manufacturer)),
 model text not null default '*' check(char_length(model) between 1 and 100 and model=btrim(model)),
 firmware text not null default '*' check(char_length(firmware) between 1 and 100 and firmware=btrim(firmware)),
 parameters jsonb not null default '[]' check(jsonb_typeof(parameters)='array' and jsonb_array_length(parameters)<=64),
 inform_interval integer check(inform_interval is null or inform_interval between 60 and 86400),
 active boolean not null default true,
 revision integer not null default 1 check(revision>0),
 created_by uuid references users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(tenant_id,id),
 check(jsonb_array_length(parameters)>0 or inform_interval is not null)
);
create unique index acs_templates_name on acs_templates(tenant_id,lower(name));
create index acs_templates_scope on acs_templates(tenant_id,active,name,id);
alter table acs_templates enable row level security;
create policy acs_templates_read on acs_templates for select using (tenant_id=app_tenant() and app_subscriber() is null);
create policy acs_templates_insert on acs_templates for insert with check (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
create policy acs_templates_update on acs_templates for update using (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null) with check (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
create policy acs_templates_delete on acs_templates for delete using (tenant_id=app_tenant() and app_subscriber() is null and app_pops() is null);
grant select,insert,update,delete on acs_templates to nexo_app;

-- A aplicação de template usa o mesmo diário durável das demais tarefas ACS.
alter table acs_task_intents drop constraint acs_task_intents_kind_check;
alter table acs_task_intents add constraint acs_task_intents_kind_check check(kind in ('wifi','refresh','reboot','template'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin
 if exists(select 1 from acs_task_intents where kind='template') then
  raise exception 'Preserve as intenções ACS de template já registradas; rollback destrutivo proibido';
 end if;
end $$;
alter table acs_task_intents drop constraint acs_task_intents_kind_check;
alter table acs_task_intents add constraint acs_task_intents_kind_check check(kind in ('wifi','refresh','reboot'));
drop table acs_templates;
-- +goose StatementEnd
