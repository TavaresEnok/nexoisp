# B07: operações recuperáveis e devoluções parciais

Implementação local de 26/10/2026, sobre `0901aa7`. Nenhuma conta bancária, equipamento ou banco produtivo foi utilizado. Efí permanece exclusivamente sandbox e com os novos consumidores desligados por padrão. B07 completo ainda requer UI operacional, notificações Cobranças, configuração do callback e homologação.

## Revisão do modelo financeiro

Antes de alterar, foram examinados os usos de `reversal_of`, o índice da migração 21, o validador/ledger da 66, `finance/core.go` (`Reverse`, `Paid`), `gateway.go` (`Payment`), consumidores B05, consultas de saldo/extrato e `apps/web/features/finance/invoice.tsx`.

O dinheiro continua em `payments`, com `signed_cents`, alocações e shadow existentes. Nenhum segundo ledger foi criado. Baixas manuais continuam permitindo somente uma reversão integral, pela autorização e SQL já existentes. Devolução do fornecedor usa linhas negativas novas, com `provider_refund_id` e `provider_return_id`, ambos únicos por conexão, referenciando o recebimento original.

Migração 73 serializa inserções pela fatura, preserva o histórico e limita a soma de devoluções ao recebimento original. Não concede UPDATE/DELETE no histórico de pagamentos. Replay exato é permitido inclusive após devolução integral; identidade, valor, data ou parent divergentes são recusados. Nova devolução exige data de liquidação com fuso e não pode preceder o recebimento. O limite monetário do armazenamento não foi ampliado.

Os leitores continuam somando valores assinados; nominal e obrigação não são reduzidos para fingir que não houve recebimento/devolução. A interface agora distingue devolução parcial de estorno integral e mantém a ação manual apenas para baixas manuais.

## Intenções e autorização

Migração 74 cria `provider_operations`: identidade imutável, intenção UUID, produto/fatura/conta vinculados ao journal de emissão, motivo, autor, centavos, referência ao pagamento, correlação remota, estado e tentativas. RLS exige tenant e escopo completo; o papel da aplicação não pode apagar operações. Preparação e auditoria pertencem à mesma transação.

Sob `/api/financial-connections/{id}/issuance/{issuanceId}/operations`:

- POST (`finance:write`, escopo completo): prepara `cancel` ou `refund`, com `intent_id` e `reason` de 10–500 caracteres. Refund exige UUID do recebimento e `amount_cents`. Cancel não admite recebimento/valor no corpo. Não faz HTTP ao fornecedor.
- GET (`finance:read`, escopo completo): lista metadados e correlação remota, sem segredos. Um perfil com finance:read pode ler; isso não autoriza POST.
- POST `/{operationId}/retry-lookup` (`finance:write`, escopo completo): motivo obrigatório, somente uncertain/review, sem alteração da intenção ou autorização de reenvio.

Intenções iguais convergem; conteúdo divergente retorna 409. A soma de devoluções confirmadas mais intenções prepared/uncertain/review reserva o limite do pagamento. Rejeição autoritativa `NAO_REALIZADO` encerra a intenção sem caixa e permite outra intenção legítima. Timeout/404 não liberam a reserva automaticamente.

## Envio e recuperação

`RunProviderOperation` toma locks na ordem fatura → operação, confere o hash da configuração congelada e grava uncertain antes do transporte. Uma tentativa posterior chama exclusivamente lookup. Confirmed/rejected são terminais; review pode retornar somente a uncertain. Nenhum caminho retorna a prepared.

| Produto | Cancelamento | Devolução |
|---|---|---|
| Pix Cob | GET validado, PATCH `/v2/cob/{txid}`, GET de confirmação | GET do Pix original, PUT de devolução com ID durável e GET de confirmação |
| Pix CobV | Mesmo protocolo, endpoint `/v2/cobv/{txid}` e identidade específica de CobV | Gestão de Pix com e2eId original, sem reutilizar o protocolo Cobranças |
| Boleto/Bolix | GET validado, PUT `/v1/charge/{id}/cancel`, GET de confirmação | Não habilitada neste contrato; solicitação é recusada, sem fallback para Pix ou estorno manual |

Pix `EM_PROCESSAMENTO` não posta débito; somente `DEVOLVIDO`, com ID/rtrId, centavos e horário de liquidação válidos, pode criar reversão. `NAO_REALIZADO` não cria reversão. A resposta da mutação é seguida de consulta; timeout mantém resultado incerto. Transportes são TLS verificado/mTLS conforme produto, com autenticação atual e semântica congelada da intenção.

Cancelamento confirmado registra `invoices.provider_canceled_at` protegido por prova no journal e coloca a obrigação em revisão. **Remover cobrança no PSP não extingue automaticamente a obrigação no ERP.** Nominal, vínculo e pagamentos permanecem preservados; o fluxo antigo de cancelamento local não foi usado como atalho. Liquidação tardia de Bolix é possível: registra dinheiro e revisão, sem nova reativação automática.

Consulta que já encontra recebimento e devolução aplica o caixa líquido em revisão na mesma transação, sem passar transitoriamente por Paid/B05. Recebimentos consultados no fornecedor posteriores a uma remoção confirmada ou a devoluções anteriores também não apagam a revisão.

## Gates e operação

- `NEXO_GO_EFI_SANDBOX_ENABLED=1`: capacidade sandbox geral; production continua recusado.
- `NEXO_GO_JOB_PSP_OPERATIONS=1`: agenda consumidor. Default 0.
- `NEXO_GO_EFI_OPERATIONS_WRITE=1`: permite consumir novas intenções prepared. Default 0. Com 0, o consumidor habilitado continua consultando uncertain; não interrompe uma requisição já iniciada.
- Credenciais/certificados permanecem no cofre versionado. Os flags de emissão e recebimento do lote 08 mantêm suas funções separadas.

Não foi executado compose/deploy. Para retorno, pausar novas mutações, manter lookup controlado e preservar journal/chaves/caixa. Build atual exige schema 74. Tag de código anterior não autoriza downgrade destrutivo. Down 73/74 é bloqueado.

## Verificação e limites

Go/race cobre concorrência, limite acumulado, duas intenções legítimas, replay após limite integral, IDs/rtrId divergentes, pendente/rejeitado, perda de resposta, SIGKILL antes/depois do efeito sintético e consulta sem reenvio. A API nativa verifica autorização, replay concorrente, reserva de valor e rollback por falha de auditoria. O navegador verifica saldo residual e rótulos parcial/integral, com dados sintéticos e API/cookies reais.

`provider_operations_migration.py` cobre 72→74, preservação financeira, rekey, dump/restauração lógica, intenção incerta e devolução parcial preservadas, chave incorreta recusada e replay autenticado. O contrato histórico 69→72 é conferido antes de preparar o schema atual para os testes de API; não se afirma compatibilidade do binário 74 com banco 72. O sqlc passa a incluir a nova coluna nas projeções geradas.

Continuam pendentes: UI operacional para emitir/cancelar/devolver/revisar com intenção persistente; resolução administrativa de resultados incertos comprovadamente sem efeito; notificações próprias de Cobranças; registro/roteamento/retenção do callback; política de nova cobrança após remoção; homologação por produto. Bolix não ganha capacidade de devolução bancária por existir uma reversão no ledger. Não se homologaram split, MED/chargeback ou devolução em produto sem contrato implementado.

Testes de loopback e dump lógico são T, não H/P, restauração física ou confirmação bancária. Evidências externas ao checkout: `implementacao-codex/lote09-b07-operacoes-2026-10-26/`. Relatório consolidado: `resultados-analise-nexoisp/23_IMPLEMENTACAO_B07_OPERACOES.md`.
