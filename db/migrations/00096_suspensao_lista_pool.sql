-- +goose Up
-- +goose StatementBegin
-- Modalidades de suspensão usadas no mercado (docs/estudo-campo):
--   address_list: MikroTik — o RADIUS mantém perfil e velocidade e entrega Mikrotik-Address-List=<lista>
--                 (57 concentradores estudados bloqueiam pela lista "bloqueados" com redirecionamento ao aviso);
--   pool:         o RADIUS entrega Framed-Pool=<pool de bloqueio> (padrão dos concentradores Huawei estudados).
-- suspension_profile passa a guardar o alvo da modalidade: perfil, lista ou pool.
alter table tenant_settings drop constraint tenant_settings_suspension_mode_check;
alter table tenant_settings drop constraint tenant_settings_suspension_chk;
alter table tenant_settings add constraint tenant_settings_suspension_mode_check
  check (suspension_mode in ('reject', 'profile', 'address_list', 'pool'));
alter table tenant_settings add constraint tenant_settings_suspension_chk
  check (suspension_mode = 'reject' or suspension_profile is not null);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
update tenant_settings set suspension_mode = 'reject', suspension_profile = null where suspension_mode in ('address_list', 'pool');
alter table tenant_settings drop constraint tenant_settings_suspension_mode_check;
alter table tenant_settings drop constraint tenant_settings_suspension_chk;
alter table tenant_settings add constraint tenant_settings_suspension_mode_check check (suspension_mode in ('reject', 'profile'));
alter table tenant_settings add constraint tenant_settings_suspension_chk check (suspension_mode <> 'profile' or suspension_profile is not null);
-- +goose StatementEnd
