-- +goose Up
-- +goose StatementBegin
-- Journal interno do adapter Cloud API, desligado por padrão.
-- Não grava conta, canal, aviso nem segredo. Não altera o cabeçalho cifrado do canal genérico.
-- Não apaga payments, invoices nem invoice_movements.
-- cloud_lock_timeouts não é notice_log.attempts: 0 inicial; o terceiro estouro é terminal e não dispara HTTP.
-- Retenção de notice_log (o delete já concedido a nexo_app) remove attempts por ON DELETE CASCADE.
-- cloud_notice_status permanece append-only para a aplicação. A única exceção de remoção é
-- cloud_notice_retain_expired, que tira observações expiradas sem attempt vivo e sem dado financeiro.

create table cloud_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  name text not null check (char_length(name) between 2 and 80),
  phone_number_id text not null check (char_length(phone_number_id) between 1 and 64),
  graph_version text not null check (char_length(graph_version) between 1 and 32),
  token_enc text not null,
  webhook_secret_enc text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, phone_number_id),
  constraint cloud_accounts_token_v1_ck check (token_enc like 'v1.%'),
  constraint cloud_accounts_webhook_v1_ck check (webhook_secret_enc like 'v1.%')
);

alter table notice_log drop constraint notice_log_status_check;
alter table notice_log add constraint notice_log_status_check
  check (status in ('queued','sending','sent','failed','uncertain','skipped_no_consent','skipped_settled','test'));
alter table notice_log
  add column cloud_lock_timeouts integer not null default 0,
  add constraint notice_log_cloud_lock_timeouts_ck check (cloud_lock_timeouts between 0 and 3),
  add constraint notice_log_tenant_id_uq unique (tenant_id, id);

alter table notice_channels
  add column adapter text not null default 'generic_http',
  add column cloud_account_id uuid;
alter table notice_channels
  add constraint notice_channels_adapter_ck check (adapter in ('generic_http', 'cloud_api')),
  add constraint notice_channels_adapter_account_ck check (
    (adapter = 'generic_http' and cloud_account_id is null)
    or (adapter = 'cloud_api' and cloud_account_id is not null)
  ),
  add constraint notice_channels_cloud_account_fk
    foreign key (tenant_id, cloud_account_id) references cloud_accounts (tenant_id, id);

create table cloud_notice_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  cloud_account_id uuid not null,
  notice_log_id bigint not null,
  attempt_no integer not null check (attempt_no > 0),
  state text not null,
  provider_message_id text,
  http_status integer,
  excerpt text,
  created_at timestamptz not null default now(),
  wire_at timestamptz,
  unique (tenant_id, id),
  unique (notice_log_id, attempt_no),
  constraint cloud_notice_attempts_state_ck check (state in ('reserved','wire','submitted','refused','uncertain','not_sent')),
  constraint cloud_notice_attempts_provider_ck check (provider_message_id is null or char_length(provider_message_id) between 1 and 128),
  constraint cloud_notice_attempts_http_ck check (http_status is null or http_status between 100 and 599),
  constraint cloud_notice_attempts_excerpt_ck check (excerpt is null or char_length(excerpt) <= 300),
  foreign key (tenant_id, cloud_account_id) references cloud_accounts (tenant_id, id),
  constraint cloud_notice_attempts_notice_fk
    foreign key (tenant_id, notice_log_id) references notice_log (tenant_id, id) on delete cascade
);
create unique index cloud_notice_attempts_provider_uq
  on cloud_notice_attempts (tenant_id, cloud_account_id, provider_message_id)
  where provider_message_id is not null;

create table cloud_notice_status (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  cloud_account_id uuid not null,
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 128),
  body_hash text not null,
  raw_status text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, cloud_account_id, body_hash),
  constraint cloud_notice_status_body_hash_ck check (body_hash ~ '^[a-f0-9]{64}$'),
  constraint cloud_notice_status_raw_ck check (char_length(raw_status) between 1 and 300),
  foreign key (tenant_id, cloud_account_id) references cloud_accounts (tenant_id, id)
);

alter table cloud_accounts enable row level security;
alter table cloud_notice_attempts enable row level security;
alter table cloud_notice_status enable row level security;
create policy t_cloud_accounts on cloud_accounts for all
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cloud_accounts on cloud_accounts as restrictive for all
  using (app_subscriber() is null);
create policy t_cloud_notice_attempts on cloud_notice_attempts for all
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cloud_notice_attempts on cloud_notice_attempts as restrictive for all
  using (app_subscriber() is null);
create policy t_cloud_notice_status on cloud_notice_status for all
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_cloud_notice_status on cloud_notice_status as restrictive for all
  using (app_subscriber() is null);

revoke all on cloud_accounts, cloud_notice_attempts, cloud_notice_status from public;
grant select, insert, update on cloud_accounts to nexo_app;
grant select, insert, update on cloud_notice_attempts to nexo_app;
grant select, insert on cloud_notice_status to nexo_app;

create function cloud_notice_status_append_only() returns trigger
language plpgsql as $cloud_status$
begin
  if tg_op = 'DELETE' and current_setting('app.cloud_notice_retention', true) = 'on' then
    return old;
  end if;
  raise exception 'cloud notice status is append-only';
end
$cloud_status$;
revoke all on function cloud_notice_status_append_only() from public;
create trigger cloud_notice_status_append_only
  before update or delete on cloud_notice_status
  for each row execute function cloud_notice_status_append_only();

create function cloud_notice_retain_expired(p_before timestamptz) returns integer
language plpgsql security definer set search_path = pg_catalog, public as $cloud_retain$
declare
  removed integer;
begin
  if public.app_subscriber() is not null or public.app_tenant() is null then
    raise exception 'cloud notice retention denied' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('app.cloud_notice_retention', 'on', true);
  delete from public.cloud_notice_status s
   where s.tenant_id = public.app_tenant()
     and s.created_at < p_before
     and not exists (
       select 1 from public.cloud_notice_attempts a
        where a.tenant_id = s.tenant_id
          and a.cloud_account_id = s.cloud_account_id
          and a.provider_message_id = s.provider_message_id
     );
  get diagnostics removed = row_count;
  perform pg_catalog.set_config('app.cloud_notice_retention', 'off', true);
  return removed;
end
$cloud_retain$;
revoke all on function cloud_notice_retain_expired(timestamptz) from public;
grant execute on function cloud_notice_retain_expired(timestamptz) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $cloud_down$
declare
  hist boolean;
begin
  hist := exists (select 1 from cloud_accounts)
    or exists (select 1 from cloud_notice_attempts)
    or exists (select 1 from cloud_notice_status)
    or exists (select 1 from notice_log where status = 'skipped_settled' or cloud_lock_timeouts <> 0)
    or exists (select 1 from notice_channels where adapter is distinct from 'generic_http' or cloud_account_id is not null);
  if hist then
    raise exception 'Preserve cloud notice journal history; do not delete notice or financial history to roll back migration 79';
  end if;
  drop trigger if exists cloud_notice_status_append_only on cloud_notice_status;
  drop function if exists cloud_notice_retain_expired(timestamptz);
  drop function if exists cloud_notice_status_append_only();
  drop table if exists cloud_notice_status;
  drop table if exists cloud_notice_attempts;
  alter table notice_channels drop constraint if exists notice_channels_cloud_account_fk;
  alter table notice_channels drop constraint if exists notice_channels_adapter_account_ck;
  alter table notice_channels drop constraint if exists notice_channels_adapter_ck;
  alter table notice_channels drop column if exists cloud_account_id;
  alter table notice_channels drop column if exists adapter;
  drop table if exists cloud_accounts;
  alter table notice_log drop constraint if exists notice_log_cloud_lock_timeouts_ck;
  alter table notice_log drop column if exists cloud_lock_timeouts;
  alter table notice_log drop constraint if exists notice_log_tenant_id_uq;
  alter table notice_log drop constraint if exists notice_log_status_check;
  alter table notice_log add constraint notice_log_status_check
    check (status in ('queued','sending','sent','failed','uncertain','skipped_no_consent','test'));
end
$cloud_down$;
-- +goose StatementEnd
