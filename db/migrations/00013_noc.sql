-- +goose Up
-- +goose StatementBegin
-- Expansão 5 (pós-MVP): NOC — limiares definidos pelo próprio provedor. Sem valor configurado, o sistema não classifica o sinal.
alter table tenant_settings
  add column onu_rx_min_dbm numeric(5,2) check (onu_rx_min_dbm between -40 and 0),      -- abaixo disso a ONU é listada como "sinal fraco"
  add column pon_outage_min integer not null default 3 check (pon_outage_min between 2 and 500);  -- ONUs offline na mesma PON para suspeitar de falha coletiva
-- +goose StatementEnd
