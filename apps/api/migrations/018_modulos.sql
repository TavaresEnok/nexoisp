-- Módulos liberados por provedor. O núcleo (cadastro, contratos, PPPoE, financeiro, portal, importação, auditoria, agentes)
-- não é módulo: está sempre disponível. O que é adicional ou ainda não homologado fica desligado até o operador do SaaS liberar.
alter table tenants add column modules text[] not null default '{}'
  check (modules <@ array['olt','ipam','field','ftth','crm','noc','notices']);
-- instalações que já usavam os recursos antes deste controle continuam com eles
update tenants set modules = array['olt','ipam','field','ftth','crm','noc','notices'];
