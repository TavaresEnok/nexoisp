-- +goose Up
-- +goose StatementBegin
-- Driver de OLT Datacom (DmOS): identidade e backup de configuração (show running-config). Reconhecido em
-- equipamento real (docs/estudo-campo/recon-cli-olts.md). Leitura/autorização de ONU ainda não implementadas.
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','olt_zte','olt_datacom','radius'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
delete from devices where driver = 'olt_datacom';
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','olt_zte','radius'));
-- +goose StatementEnd
