-- +goose Up
-- +goose StatementBegin
-- Driver de OLT ZTE ZXA10 (GPON): leitura de ONU e backup de configuração (show running-config).
-- Reconhecido em equipamento real (docs/estudo-campo/recon-cli-olts.md). Autorização de ONU não homologada.
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','olt_zte','radius'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
delete from devices where driver = 'olt_zte';
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','radius'));
-- +goose StatementEnd
