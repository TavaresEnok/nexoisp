-- +goose Up
-- +goose StatementBegin
-- Expansão OLT/ONU: primeiro fabricante real (Huawei SmartAX MA5600/MA5800) e perfil de serviço da ONU.
alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo','olt_huawei'));
alter table onus add column service_profile text check (service_profile ~ '^[A-Za-z0-9_.-]{1,60}$');
-- +goose StatementEnd
