# Lote 01 consolidado localmente — 26/10/2026

Base de continuação: `/home/enok/Documentos/projetos/NexoISP`, branch
`dev/lote01-consolidado-2026-10-26`. Não continuar alterando a cópia histórica
`implementacao-codex/lote-01-2026-10-25/NexoISP`.

A tag `base/pre-lote01-2026-10-26` preserva as alterações locais recebidas em
commit próprio, sobre o histórico original. Bundles de recuperação, comandos,
logs e relatório estão em `../implementacao-codex/consolidacao-lote01-2026-10-26/`
e `../resultados-analise-nexoisp/15_CONSOLIDACAO_LOTE01.md` (a partir da raiz do
checkout NexoISP). Nenhum push, merge na branch principal ou deploy foi realizado.

## Contrato de baixa e compatibilidade

`POST /api/invoices/:id/manual-payment` exige `intent_id` UUID gerado uma vez
por intenção humana, além dos campos financeiros existentes. Reenvio após
resposta perdida usa exatamente o mesmo UUID e payload, inclusive depois de
quitação ou estorno. Outro recebimento legítimo, mesmo de valor igual, exige
novo UUID. Não gerar UUID a cada tentativa nem deduplicar pelo valor.

A API revalida `finance:write` e visibilidade de tenant/POP em cada replay.
Intenção fica vinculada ao autor e fatura; mudança de autor/payload/fatura
retorna conflito. Clientes sem UUID são recusados antes da gravação. O frontend
oficial persiste intenção por tenant/usuário/fatura antes de enviar; requer
contexto seguro (HTTPS ou localhost), Web Locks e armazenamento disponível.
Falha ambígua conserva o formulário e a intenção. Não limpar armazenamento
pendente sem conferir os recebimentos.

Consumidores ativos encontrados: `apps/web/features/finance/actions.tsx`,
`tests/contrato/nativo.py`, `payment_intents.py`, cenário finance-access e teste
browser lote01. Todos usam UUID. `apps/web-legacy` é somente referência histórica
conforme AGENTS.md e não é cliente compatível para reativação. Integrações externas
não presentes no checkout precisam ser inventariadas pelo operador antes de uma
futura troca de versão; não há fallback servidor que invente intenção silenciosa.

## Migração 64 e recuperação

Migração aditiva; não altera linhas antigas de invoices/payments. Não inventa
intenções para pagamentos históricos. PK tenant/intenção, vínculo composto da
fatura, RLS por tenant, portal negado e POP herdado da fatura. A API recusa papel
proprietário/BYPASSRLS. Down recusa apagar a tabela deliberadamente: voltar o
binário antigo mantendo escrita financeira liberada perderia a garantia de
idempotência.

Antes de futura implantação: snapshot coerente, conferir backups e clientes,
suspender baixas, migrar, atualizar API/frontend juntos e validar antes de liberar.
Em recuperação: suspender escrita e consumidores, preservar/exportar intenções,
pagamentos e eventos posteriores ao snapshot; restaurar em ambiente isolado e
reconciliar efeitos antes de permitir replay. Não executar down destrutivo nem
restaurar snapshot antigo sobre recebimentos posteriores sem reconciliação.
Esta consolidação executou apenas migração e recuperação sintéticas.

## Validação e limites

Instalação limpa, format/typecheck/build, 175 testes web; contratos financeiros
com 100 replays em duas APIs; teste adicional de RLS da migração 64 com fixture
revertida; upgrade 63→64 preservando fatura e pagamento; navegador dirigido,
perda de resposta HTTP após commit e seis referências visuais. As evidências
originais e da consolidação permanecem separadas. Os componentes/estilos oficiais
não foram redesenhados. Os PNGs atualizados correspondem ao código recebido;
ver `e2e/visual-baselines/operacional/REVISAO.md`.

CI hospedado, homologação bancária/fiscal/equipamentos e piloto não realizados.
O relatório 15 mantém dívidas de dependências por alcance e a sequência financeira
B03→B04→B05→B06 e rede B10→B09→B11, com dependências cruzadas e gates externos.
