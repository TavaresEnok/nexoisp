-- Aceite eletrônico simples de documento do contrato (termo, aditivo): o assinante, autenticado no portal, aceita o texto exato
-- e o sistema guarda quando, de onde e um resumo criptográfico do que foi aceito. NÃO é assinatura avançada nem qualificada (ICP-Brasil).
create table acceptances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  subscriber_id uuid not null,
  amendment_id uuid,
  title text not null check (char_length(title) between 3 and 120),
  body text not null check (char_length(body) between 1 and 8000),     -- cópia do texto no momento do pedido: o que foi aceito não muda
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','accepted','canceled')),
  requested_by uuid references users(id),
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references users(id),                             -- usuário do portal que aceitou
  accepted_ip text,
  accepted_user_agent text check (char_length(accepted_user_agent) <= 300),
  evidence_hash text check (evidence_hash ~ '^[0-9a-f]{64}$'),
  canceled_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, amendment_id) references contract_amendments (tenant_id, id),
  check ((status = 'accepted') = (accepted_at is not null and evidence_hash is not null)),
  check ((status = 'canceled') = (canceled_at is not null))
);
create index acceptances_contract on acceptances (tenant_id, contract_id, requested_at desc);
create index acceptances_subscriber_pending on acceptances (tenant_id, subscriber_id) where status = 'pending';
create unique index acceptances_pending_same on acceptances (tenant_id, contract_id, body_hash) where status = 'pending';

-- Depois de aceito, o texto e a prova não mudam (nem o dono do banco altera sem apagar a trava).
create function acceptances_immutable() returns trigger language plpgsql as $$
begin
  if old.status = 'accepted' and (new.status <> old.status or new.body is distinct from old.body or new.body_hash is distinct from old.body_hash
     or new.accepted_at is distinct from old.accepted_at or new.accepted_ip is distinct from old.accepted_ip or new.evidence_hash is distinct from old.evidence_hash
     or new.title is distinct from old.title) then
    raise exception 'aceite já registrado não pode ser alterado' using errcode = '42501';
  end if;
  if old.status = 'canceled' and new.status <> 'canceled' then raise exception 'pedido cancelado não pode ser reaberto' using errcode = '42501'; end if;
  return new;
end $$;
create trigger acceptances_immutable before update on acceptances for each row execute function acceptances_immutable();

alter table acceptances enable row level security;
create policy t_acc on acceptances for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
-- Assinante: só os próprios; a gravação do aceite sai pelo escopo do provedor, depois de conferir a posse.
create policy portal_acc on acceptances as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
grant select, insert, update on acceptances to nexo_app;
