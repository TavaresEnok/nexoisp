-- +goose Up
-- +goose StatementBegin
-- Estudo de campo (10/11/2026): em CGNAT dedicado o titular só sai do registro de NAT do
-- equipamento, e só 1 de 9 Hillstone exportava esse registro. O plano declara de onde ele vem:
--   syslog:    o equipamento envia o registro de alocação a um servidor de logs;
--   equipment: o registro fica no próprio equipamento (consulta manual);
--   none:      não há registro -> ofícios sobre esse IP não podem ser respondidos.
-- public_first/public_last: faixa usada dentro do bloco público quando ela não é um CIDR
-- (pools reais de 224 ou 1014 endereços). Nulos = bloco inteiro.
alter table cgnat_plans add column nat_log text check (nat_log is null or nat_log in ('syslog', 'equipment', 'none'));
alter table cgnat_plans add column nat_log_detail text check (nat_log_detail is null or length(nat_log_detail) <= 200);
alter table cgnat_plans add column public_first inet check (public_first is null or (family(public_first) = 4 and masklen(public_first) = 32));
alter table cgnat_plans add column public_last inet check (public_last is null or (family(public_last) = 4 and masklen(public_last) = 32));
alter table cgnat_plans add constraint cgnat_plans_public_range check (public_first is null or public_last is null or public_first <= public_last);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
alter table cgnat_plans drop constraint cgnat_plans_public_range;
alter table cgnat_plans drop column public_last;
alter table cgnat_plans drop column public_first;
alter table cgnat_plans drop column nat_log_detail;
alter table cgnat_plans drop column nat_log;
-- +goose StatementEnd
