# B04 — movimentos financeiros e comparação de saldos

A migração 66 acrescenta histórico financeiro sem substituir as leituras oficiais.
`payments.signed_cents` continua sendo a única fonte de dinheiro recebido.
`financial_payment_allocations` projeta a alocação já existente de cada pagamento
à sua fatura, inclusive estorno negativo. Não redistribui recebimentos nem
transforma um excedente em crédito livre para outro contrato.

`invoice_movements` registra abertura, deltas de nominal/encargos/desconto e o
estado após a alteração. O trigger participa da transação da fatura: rollback
reverte ambos. O banco recusa atualização/exclusão do histórico e dos pagamentos.
Estorno novo deve corresponder ao tenant, fatura e valor do recebimento original.
Cancelamento preserva os valores e torna o saldo cobrável zero; não é estorno.

O histórico anterior à migração é uma abertura explícita (`opening`) do saldo
conhecido, sem inventar datas ou causas de ajustes antigos. Novas faturas começam
como `created`; mudanças de valor ou estado são `adjustment`. Auditoria de ator,
intenção e motivo continua nos registros existentes das operações; a tabela de
movimentos não substitui o log de auditoria.

Acordos novos guardam `agreement_sources`, com valores e recebimentos da fatura
original e o residual transferido. Os recebimentos antigos não são copiados às
parcelas. O desconto do acordo reduz esse residual; a soma das parcelas deve
corresponder ao total. Acordos antigos sem vínculo comprovado ficam
`source_unproven=true`, não são associados por parsing de nota textual.

## Leitura comparativa

Views PostgreSQL 16 com `security_invoker=true` respeitam tenant, assinante e POP
pela visibilidade das faturas/contratos. Contratos sem POP continuam visíveis
conforme a política preexistente. Não executar conferências com papel owner como
substituto de teste de autorização.

```sql
-- Rodar em transação/contexto autorizado, configurado pela aplicação.
select invoice_id, nominal_cents, fee_cents, discount_cents, received_cents,
       residual_cents, excess_cents, collectible_cents, status, matches
from financial_balance_shadow;
select * from financial_balance_shadow where not matches;
select * from financial_agreement_shadow where not matches;
```

`matches=false` bloqueia qualquer proposta de corte. `source_unproven` é pendência
de evidência histórica, não justificativa para fabricar vínculo. As leituras
oficiais continuam intactas nesta etapa. A projeção de alocações e o recebido
legado usam a mesma fonte assinada deliberadamente; a comparação não é prova de
conciliação externa ou contabilidade de partidas dobradas. Provas independentes
vêm dos valores esperados das fixtures, protocolos de pagamento e extratos
quando homologados.

## Migração e recuperação

Antes de futura implantação, snapshot coerente e conferência de vínculos/dados
antigos são obrigatórios. A migração mantém faturas/pagamentos/acordos anteriores,
cria aberturas e instala os triggers atomicamente. Reexecução do prepare não
repete aberturas. Não editar migração aplicada. Down recusa apagar o histórico.
Não há comando de implantação nesta entrega.

Não retornar o escritor antigo: acordos criados sem `agreement_sources` ficariam
incompletos. Para recuperar, pausar escrita, restaurar snapshot em ambiente
isolado, reter e reconciliar alterações posteriores e só então decidir replay.
Correção de pagamento histórico ou associação de conta legada exige procedimento
controlado e auditável: não desabilitar triggers em operação normal. Dumps e
restaurações do laboratório são dados sintéticos; não comprovam PITR/RPO/RTO.

## Regressões e continuidade

- `tests/contrato/nativo.py`: inclui comparação após B02/B03, cenários autenticados
  de acordo parcial, ajustes, estorno/excesso, rollback, RLS e drift sintético.
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/financial_movements_migration.py`:
  PostgreSQL próprio, upgrade 65→66, abertura histórica, repetição e pendências.
- Novo passo em `.github/workflows/native.yml`; execução local é distinta de CI
  hospedado. Resultados finais e limites no relatório 17 do workspace.

Próximo lote B05: recebimento confirmado independente de falha técnica, intenção
única/outbox e retomada crash/replay. Não mudar PSP, rede ou interface para aprovar
B04. B06/providers e B10→B09/B11 continuam no backlog separado.
