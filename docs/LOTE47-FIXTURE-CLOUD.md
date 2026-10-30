# Lote 47 — fixture Cloud

Na validação PostgreSQL do lote 46, C17, C19, C24 e C27 falharam na preparação: a seleção exigia `tenant_settings` e contrato ativo, mas o seed não garante uma linha de configuração. Um tenant adicional sem configuração nem contrato também antecedia os demais no diretório.

A fixture seleciona um tenant com contrato ativo no escopo RLS, sem exigir configuração. Para a retenção, a ausência de linha e o valor nulo usam o mesmo fallback do `radius.Purge`; um valor configurado é preservado. Erros de consulta continuam falhando o teste. A correção não altera configurações ou contratos de outros tenants nem código de produção.

A regressão offline cobre seleção, propagação de erro e resolução da retenção. A validação PostgreSQL real com `NEXO_CLOUD_PG_REQUIRED=1`, a revisão independente e o CI permanecem pendentes até seus respectivos recibos. Esta alteração não comprova publicação ou SBOM.
