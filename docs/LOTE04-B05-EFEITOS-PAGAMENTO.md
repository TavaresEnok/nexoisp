# B05 — recebimento confirmado e efeito técnico separado

A baixa confirma o financeiro sem planejar rede na mesma transação. A migração
67 adiciona `invoices.settlement_version` e a caixa durável `payment_effects`.
Cada transição para `paid` cria uma pendência única por tenant/fatura/versão;
repetir o mesmo estado não cria outra. Estorno seguido de nova quitação cria
nova versão. Faturas já pagas antes da migração e títulos históricos inseridos como pagos
não geram ações retroativas. O importador existente insere o estado histórico
diretamente; uma nova quitação posterior por transição de estado é distinta.
A gravação financeira, intenção manual, movimento B04 e pendência são atômicos.
Uma falha de persistência desse conjunto ainda deve recusar a baixa; isso é
segurança transacional, não acoplamento ao dispositivo.

`finance.Paid` mantém o evento financeiro para os webhooks e o encerramento da
confiança. `network.Request` e a auditoria de retomada saíram dessa transação.
O consumidor `PAYMENT_EFFECTS` usa o dispatcher River por tenant existente. A
pendência de negócio não depende da retenção/retry de um job River específico.

## Consumo e semântica

- Lote de até 100 pendências vencidas por tenant; transação independente para
  cada uma, limite de dez segundos para planejar cada efeito.
- Revalidar fatura paga e versão, política atual, contrato ativo, recurso suspenso
  por inadimplência e ausência de outra fatura vencida conforme a política atual.
  Suspensão manual não é removida. Fatura estornada antes do consumo é ignorada.
- Bloquear primeiro a fatura, depois a pendência/recurso; mesma ordem financeira.
  Intenção de rede, outbox River existente, auditoria e conclusão da pendência
  são confirmados juntos. Chave de rede: `finance-paid:<effect UUID>`.
- Falha técnica reverte somente o planejamento. Pendência continua `pending`,
  com tentativas, próximo horário e indicação de erro; intervalo cresce de um
  minuto até uma hora. A causa detalhada fica no log do worker. O erro de um
  dispositivo não impede processar os outros efeitos do lote.
- `planned` significa intenção de rede persistida, não execução física. Consultar
  `operations`/tentativas para resultado técnico. Não recriar intenção para
  disfarçar operação `UNKNOWN`, expirada, falha ou que precise readback.
- `ignored` conserva o motivo: quitação superada, política desabilitada, ausência
  de suspensão elegível ou outra dívida. Não é apagada nem automaticamente
  reativada por mudança posterior de política.

Reversão **posterior** ao planejamento não desfaz automaticamente um efeito já
confirmado/enviado. Nova avaliação de cobrança/suspensão é uma operação distinta;
não existe transação distribuída com o equipamento. B09/B10/B11 continuam
responsáveis pelos contratos físicos, readback e tratamento do desconhecido.

## Ativação e pausa

Consumidor exige `NEXO_GO_JOBS=1` e `NEXO_GO_JOB_PAYMENT_EFFECTS=1`. O Compose
expõe a segunda variável com padrão **0**: habilitação futura é explícita.
Pausar o consumidor e reiniciar controladamente os workers conserva pendências.
`auto_resume_on_payment` continua sendo a decisão comercial por tenant.

O laboratório habilitou apenas este consumidor nos cenários B05; execução RADIUS
foi mantida desligada. O teste de navegador financeiro/acesso espera a intenção
assíncrona, sem substituir o estado esperado por mock nem afirmar aplicação no
NAS. Interface oficial e estilos permanecem intactos.

## Observação

Consultas sob contexto autorizado do tenant, não com bypass de RLS:

```sql
select status, count(*), min(created_at) as oldest
from payment_effects group by status;
select id, invoice_id, settlement_version, attempts, next_attempt_at, last_error
from payment_effects where status='pending' order by next_attempt_at;
select e.id, e.outcome, e.operation_id, o.status as network_status
from payment_effects e left join operations o on o.id=e.operation_id;
```

Os contadores de sucesso da tarefa River indicam execução do lote, não sucesso
físico nem ausência de pendências individuais. Conferir `payment_effects` e os
logs correlacionados por tenant/effect. Não alterar estado/IDs da caixa manualmente
para simular recuperação. A flag de pausa não apaga jobs ou eventos.

## Migração/recuperação

Migração aditiva em transação, com lock de escrita na fatura para instalar contador
+trigger atomicamente. Sem backfill de efeitos. Down destrutivo recusado. Snapshot
coerente e revisão das pendências antecedem eventual implantação; não misturar
escritores anteriores, que ainda planejam rede dentro da baixa, com este contrato.

Recuperar código pela tag/bundle pré-B05; recuperar dados por restauração isolada
e conciliação dos recebimentos/eventos posteriores ao snapshot. Não executar
rollback que perca deduplicação ou repita efeitos já enviados. Ensaio local não
prova recuperação física, PITR ou RPO/RTO.

## Regressões

- `tests/contrato/payment_effects.py`: PostgreSQL próprio, APIs/River reais,
  falha depois da intenção antes do commit, concorrência, tenants, estorno,
  dois consumidores, reparo, SIGKILL e retomada. Nenhum comando físico executado.
- `tests/contrato/payment_effects_migration.py`: 66→67, linhas preservadas,
  nenhuma ação retroativa, rollback e versões; recusa de Down/forja pelo app.
- `tests/contrato/nativo.py`: regressões B02/B03/B04; `e2e.py` e
  `frontend-v0-finance-access.mjs`: confirmação assíncrona de retomada.

Resultado completo e commits: relatório 18 do workspace. Próximo lote financeiro
B06: contrato de adapter e simulador adverso; não ativar PSP real nesta etapa.
