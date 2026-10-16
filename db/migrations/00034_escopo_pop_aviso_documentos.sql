-- +goose Up
-- +goose StatementBegin
-- D11 permissão por POP, C5 página de aviso do provedor, P4 documentos do assinante.

-- ---- D11: usuário restrito a POPs -------------------------------------------------------------------------------
-- Sem linhas aqui o usuário vê tudo do provedor (como antes). Com linhas, só contratos dos POPs listados e os SEM POP.
-- A restrição é feita no banco (políticas restritivas), não em cada consulta: uma rota nova já nasce filtrada.
create table user_pops (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  pop_id uuid not null,
  primary key (user_id, pop_id),
  foreign key (tenant_id, pop_id) references pops (tenant_id, id) on delete cascade
);
alter table user_pops enable row level security;
create policy t_upop on user_pops for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_upop on user_pops as restrictive for all using (app_subscriber() is null);
grant select, insert, delete on user_pops to nexo_app;

create function app_pops() returns uuid[] language sql stable as
  $$ select nullif(string_to_array(nullif(current_setting('app.pop_ids', true), ''), ','), '{}')::uuid[] $$;
grant execute on function app_pops() to nexo_app;

-- Assinante visível: sem contrato nenhum (recém-cadastrado) ou com algum contrato num POP permitido / sem POP.
-- SECURITY DEFINER para enxergar todos os contratos do assinante (a política de contratos esconderia os de outros POPs).
create function subscriber_in_pops(p_subscriber uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select not exists (select 1 from contracts k where k.subscriber_id = p_subscriber and k.tenant_id = app_tenant())
      or exists (select 1 from contracts k where k.subscriber_id = p_subscriber and k.tenant_id = app_tenant()
                 and (k.pop_id is null or k.pop_id = any(app_pops()))) $$;
revoke execute on function subscriber_in_pops(uuid) from public;
grant execute on function subscriber_in_pops(uuid) to nexo_app;

create policy pop_contracts on contracts as restrictive for all
  using (app_pops() is null or pop_id is null or pop_id = any(app_pops()));
create policy pop_subscribers on subscribers as restrictive for all
  using (app_pops() is null or subscriber_in_pops(id));
-- filhos: seguem a visibilidade do contrato ou do assinante (a subconsulta já passa pelas políticas acima)
create policy pop_invoices on invoices as restrictive for all
  using (app_pops() is null or exists (select 1 from contracts k where k.id = contract_id));
create policy pop_resources on service_resources as restrictive for all
  using (app_pops() is null or exists (select 1 from contracts k where k.id = contract_id));
create policy pop_work_orders on work_orders as restrictive for all
  using (app_pops() is null or exists (select 1 from subscribers s where s.id = subscriber_id));
create policy pop_tickets on tickets as restrictive for all
  using (app_pops() is null or exists (select 1 from subscribers s where s.id = subscriber_id));

-- ---- C5: página de aviso do provedor (pública, sem dado de assinante) ---------------------------------------------
alter table tenant_settings add column notice_page jsonb check (notice_page is null or (jsonb_typeof(notice_page) = 'object' and pg_column_size(notice_page) < 4000));
create function notice_page_get(p_slug text) returns table (name text, page jsonb)
  language sql stable security definer set search_path = public as $$
  select t.name, s.notice_page from tenants t join tenant_settings s on s.tenant_id = t.id
  where t.slug = p_slug and t.status = 'active' and s.notice_page is not null $$;
revoke execute on function notice_page_get(text) from public;
grant execute on function notice_page_get(text) to nexo_app;

-- ---- P4: documentos do assinante ----------------------------------------------------------------------------------
-- Conteúdo no próprio banco (entra no backup e no isolamento por provedor). Excluir apaga o conteúdo e mantém o registro.
create table documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscriber_id uuid not null,
  contract_id uuid,
  kind text not null check (kind in ('identity','address_proof','contract','photo','other')),
  name text not null check (char_length(name) between 1 and 120),
  mime text not null check (mime in ('application/pdf','image/jpeg','image/png','image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  sha256 text not null,
  content bytea,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  unique (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check ((content is null) = (deleted_at is not null))
);
create index documents_subscriber on documents (tenant_id, subscriber_id, created_at desc);
alter table documents enable row level security;
create policy t_doc on documents for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_doc on documents as restrictive for all using (app_subscriber() is null);
create policy pop_documents on documents as restrictive for all
  using (app_pops() is null or exists (select 1 from subscribers s where s.id = subscriber_id));
grant select, insert, update on documents to nexo_app;
-- +goose StatementEnd
