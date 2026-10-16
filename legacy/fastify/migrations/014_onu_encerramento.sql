-- Regra do provedor: desautorizar a ONU na OLT quando o contrato é encerrado. Desligada por padrão (o painel apenas avisa).
alter table tenant_settings add column onu_remove_on_contract_end boolean not null default false;
