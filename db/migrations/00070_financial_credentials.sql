-- +goose Up
-- +goose StatementBegin
alter table users add constraint users_tenant_identity_uq unique(tenant_id,id);
create table financial_credential_versions (
 id uuid primary key,
 tenant_id uuid not null,
 financial_connection_id uuid not null,
 version integer not null check(version>0),
 kind text not null check(kind in ('efi_pix','efi_charges')),
 secret_enc text not null check(secret_enc like 'v1.%'),
 certificate_sha256 text not null,
 certificate_expires_at timestamptz,
 check((kind='efi_pix' and certificate_sha256 ~ '^[a-f0-9]{64}$' and certificate_expires_at is not null) or (kind='efi_charges' and certificate_sha256='' and certificate_expires_at is null)),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 unique(tenant_id,financial_connection_id,id),
 unique(financial_connection_id,version),
 foreign key(tenant_id,financial_connection_id) references financial_connections(tenant_id,id),
 foreign key(tenant_id,created_by) references users(tenant_id,id)
);
alter table financial_credential_versions enable row level security;
create policy credential_tenant on financial_credential_versions using(tenant_id=app_tenant()) with check(tenant_id=app_tenant());
create policy credential_scope on financial_credential_versions as restrictive for all using(app_subscriber() is null and app_pops() is null);
grant insert on financial_credential_versions to nexo_app;
-- No wildcard access to ciphertext, even via an accidental SELECT *.
grant select(id,tenant_id,financial_connection_id,version,kind,certificate_sha256,certificate_expires_at,created_at,created_by) on financial_credential_versions to nexo_app;
alter table financial_connections add column credential_version_id uuid,
 add constraint connection_credential_fk foreign key(tenant_id,id,credential_version_id) references financial_credential_versions(tenant_id,financial_connection_id,id);
create function financial_credential_kind_guard() returns trigger language plpgsql as $$
declare oldkind text; newkind text;
begin
 if new.credential_version_id is not distinct from old.credential_version_id then return new; end if;
 if old.credential_version_id is not null then
  select kind into oldkind from financial_credential_versions where id=old.credential_version_id;
  select kind into newkind from financial_credential_versions where id=new.credential_version_id;
  if oldkind is distinct from newkind then raise exception 'credential API kind is immutable; register a separate connection'; end if;
 end if;
 return new;
end $$;
revoke all on function financial_credential_kind_guard() from public;
create trigger financial_credential_kind_guard before update on financial_connections for each row execute function financial_credential_kind_guard();
alter table provider_issuance add column credential_version_id uuid,
 add constraint issuance_credential_fk foreign key(tenant_id,financial_connection_id,credential_version_id) references financial_credential_versions(tenant_id,financial_connection_id,id);
-- Existing synthetic/unwired intentions retain NULL. Operational entry requires
-- a version; do not assign a newly rotated identity to an old uncertain write.
create function provider_issuance_credential_guard() returns trigger language plpgsql as $$
begin
 if new.credential_version_id is distinct from old.credential_version_id then raise exception 'issuance credential version is immutable'; end if;
 return new;
end $$;
revoke all on function provider_issuance_credential_guard() from public;
create trigger provider_issuance_credential_guard before update on provider_issuance for each row execute function provider_issuance_credential_guard();
create function financial_credential_ciphertext(cid uuid) returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select v.secret_enc from public.financial_credential_versions v where v.id=cid and v.tenant_id=public.app_tenant()
  and public.app_subscriber() is null and public.app_pops() is null
$$;
revoke all on function financial_credential_ciphertext(uuid) from public;
grant execute on function financial_credential_ciphertext(uuid) to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve credential versions referenced by provider intentions; restore keys and reconcile before rollback'; end $$;
-- +goose StatementEnd
