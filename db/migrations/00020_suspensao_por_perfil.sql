-- +goose Up
-- +goose StatementBegin
-- Modalidade de suspensão por provedor (compatibilidade com quem hoje suspende por perfil de bloqueio, como o SGP):
--   reject  = nega a autenticação e derruba a sessão (padrão, a única que existia);
--   profile = a conta continua autenticando, mas com o perfil de bloqueio (velocidade mínima / pool de aviso) configurado no NAS.
-- O perfil precisa existir no NAS: o NexoISP não o cria.
alter table tenant_settings
  add column suspension_mode text not null default 'reject' check (suspension_mode in ('reject','profile')),
  add column suspension_profile text check (suspension_profile ~ '^[A-Za-z0-9_.-]{1,60}$'),
  add constraint tenant_settings_suspension_chk check (suspension_mode <> 'profile' or suspension_profile is not null);
-- +goose StatementEnd
