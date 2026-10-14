-- TR-069: roteador do cliente (CPE) gerenciado pelo servidor de gerência integrado. O servidor é um só para a instalação;
-- cada provedor só enxerga os roteadores que vinculou aos próprios contratos (um roteador não pode ser vinculado duas vezes).
create table cpe_links (
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  acs_device_id text not null unique check (char_length(acs_device_id) between 3 and 200),
  serial text,
  linked_by uuid references users(id),
  linked_at timestamptz not null default now(),
  primary key (tenant_id, contract_id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id)
);
alter table cpe_links enable row level security;
create policy t_cpe on cpe_links for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
-- assinante: só o do próprio contrato (troca de Wi-Fi pelo portal)
create policy portal_cpe on cpe_links as restrictive for all using (
  app_subscriber() is null or exists (select 1 from contracts k where k.id = cpe_links.contract_id and k.subscriber_id = app_subscriber()));
grant select, insert, delete on cpe_links to nexo_app;
-- vínculo de outro provedor também bloqueia (sem revelar de quem é)
create function cpe_linked_anywhere(p_device text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from cpe_links where acs_device_id = p_device) $$;
revoke execute on function cpe_linked_anywhere(text) from public;
grant execute on function cpe_linked_anywhere(text) to nexo_app;
