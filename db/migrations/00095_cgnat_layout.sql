-- +goose Up
-- +goose StatementBegin
-- Como o equipamento distribui os assinantes nos IPs e portas públicos. A consulta de
-- ofício só pode calcular o titular quando o layout é conhecido:
--   sequential: regras geradas pelo NexoISP (assinante i -> IP i / blocos, bloco i % blocos);
--   netmap:     padrão MikroTik do mercado (bloco privado do tamanho do público, contíguo,
--               cada bloco seguinte com a faixa de portas seguinte);
--   external:   CGNAT dedicado (Hillstone, A10...) com alocação dinâmica ou deslocamento
--               aleatório: o titular só sai do registro de NAT do próprio equipamento.
-- port_end: última porta usada pelo equipamento (muitos param em 64511); nulo = 65535.
alter table cgnat_plans add column layout text not null default 'sequential'
  check (layout in ('sequential', 'netmap', 'external'));
alter table cgnat_plans add column port_end integer
  check (port_end is null or (port_end between port_start + 63 and 65535));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
alter table cgnat_plans drop column port_end;
alter table cgnat_plans drop column layout;
-- +goose StatementEnd
