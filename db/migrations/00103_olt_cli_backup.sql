-- +goose Up
-- +goose StatementBegin
-- Drivers de backup de configuração por CLI (sem gerência de ONU ainda): Intelbras, FiberHome, VSOL, Parks.
-- Despejam o running-config via CLI pelo transporte OS do agente (ver docs/estudo-campo/recon-cli-olts.md).
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','olt_zte','olt_datacom','olt_intelbras','olt_fiberhome','olt_vsol','olt_parks','radius'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
delete from devices where driver in ('olt_intelbras','olt_fiberhome','olt_vsol','olt_parks');
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei','olt_zte','olt_datacom','radius'));
-- +goose StatementEnd
