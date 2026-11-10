-- +goose Up
-- +goose StatementBegin
-- Estudo de campo: 13 a 15 de 41 concentradores Huawei definem a velocidade por qos-profile nomeado
-- (cir/pir), não pela taxa enviada no RADIUS. rate_mode = 'qos_profile' manda Huawei-Qos-Profile-Name
-- com o perfil do plano; 'attributes' (padrão) manda Huawei-Input/Output-Average-Rate.
alter table devices add column rate_mode text not null default 'attributes' check (rate_mode in ('attributes', 'qos_profile'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
alter table devices drop column rate_mode;
-- +goose StatementEnd
