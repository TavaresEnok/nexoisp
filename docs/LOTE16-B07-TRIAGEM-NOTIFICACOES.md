# B07 — triagem operacional de notificações — 27/10/2026

Base `9fd9d50`, mesmo checkout/branch de desenvolvimento. Nenhuma migração nova: schema76 preservado. Este recorte entrega conferência administrativa e reagendamento de consulta, sem declarar B07 ou o produto completo concluídos.

## Funcionalidade

Em Administração → Integrações → Conexões financeiras, o botão **Triagem de avisos** abre a fila da conexão Efí. Há visões de avisos a conferir, conferidos administrativamente e processados pelo fluxo de consulta, com cursor por data/UUID e até 100 registros por página.

A projeção contém identificadores e estado do aviso, data e justificativa administrativa. Não retorna token de notificação, payload bruto, CPF/e-mail do pagador, credenciais ou conteúdo do cofre. “Processado” se refere ao aviso; não equivale a pagamento confirmado.

**Marcar conferido** registra motivo, usuário, intenção e fingerprint na auditoria. Preserva o estado original do aviso, o journal de emissão e as reservas. A cobrança pode continuar exigindo resolução financeira mesmo com o aviso conferido. **Solicitar nova consulta** move review/unmatched para a fila existente de consultas dos dados originais; o handler não chama o banco/PSP nem registra recebimento. Workers/gates desligados continuam desligados.

O motivo exige 10–500 caracteres. Uma intenção tem identidade normalizada e fica ligada a ação, usuário, conexão, aviso e justificativa. Concorrência é serializada no aviso; o audit e a alteração de fila são transacionais. Perda da resposta após commit permite repetir a mesma intenção sem outra decisão. Alterar o conteúdo da intenção retorna409. Aviso já processado ou com consulta pendente não é reintroduzido por uma nova decisão.

A interface mantém o UUID enquanto o formulário está aberto; falha de transporte mantém o formulário/intenção para repetição. A conferência fica disponível na visão administrativa após recarregar a página. As visões e o diagnóstico de callback são invalidados após a ação, evitando cache antigo ao alternar entre conferidos e fila aberta. Não há persistência de dados do pagador no navegador.

## Código e autorização

- `apps/api-go/internal/finance/notice_review.go`: domínio de revisão, lock, idempotência/audit e reagendamento sem emissão/devolução/baixa.
- `apps/api-go/internal/modules/escrita/provider_notice_review.go`: `GET /api/financial-connections/{id}/notices?view=open|acknowledged|processed&before=<uuid>` e `POST /api/financial-connections/{id}/notices/{notice}/review`.
- `apps/web/features/admin/financial-notices.tsx` e `financial-connections.tsx`: entrada e formulário nos componentes oficiais existentes.

Permissão settings:manage e tenant integral; portal, POP restrito e suporte são recusados. RLS existente repete o isolamento. Cookie exige CSRF; ator vem da sessão. O domínio confere usuário ativo e escopo SQL. Nenhuma associação automática entre contas, nenhum campo do payload é aceito como dinheiro, nenhum bloqueio financeiro é relaxado.

Somente o aviso é bloqueado na revisão. Não há lock posterior de invoice/issuance, evitando inverter a ordem dos workers de recebimento. A nova consulta é consumida pelo worker existente e continua sujeita às suas verificações autenticadas.

## Validação local

Um teste Go dirigido com race cobre oito conferências concorrentes de uma intenção, perda da resposta, repetição de retry, divergência de ação, guarda de processado e manutenção da reserva. A tentativa de alterar a fatura continua recebendo N6901 depois da conferência; nenhum pagamento é criado pelo ack/retry. Oito chamadas concorrentes não são oito testes.

API/navegador com dados sintéticos: GET/cursor/filtro, outro tenant404, financeiro sem settings403, justificativa inválida400, ausência de CSRF403, conferência → histórico → nova consulta → fila aberta, duas auditorias e payload sensível ausente da resposta. Captura móvel390px inspecionada, sem overflow horizontal. Go build/vet e Node22 typecheck/build aprovados. Não foi repetida auditoria/suíte geral nem instalação de dependências.

Uma falha de locator no primeiro roteiro foi corrigida no harness. O roteiro seguinte reproduziu cache antigo ao alternar de conferidos para fila aberta; a implementação passou a invalidar todas as visões da conexão e a repetição dirigida passou. Logs e captura da falha foram preservados. A regra financeira não foi alterada para fazer o teste passar.

## Limites, recuperação e continuação

C/T locais; H/P ausentes. Sem credencial bancária, HTTP para PSP, CI hospedado, push, merge principal ou implantação. Bases originais/interface oficial preservadas. Backup-center não foi alterado.

Rollback deste recorte é de código; não remover auditorias nem avisos. O código anterior ignora os registros novos de conferência e pode mostrar mais itens, mas reservas/recebimentos permanecem no modelo anterior. Manter schema76 por causa do lote RADIUS já integrado.

Pendências internas B07: resolução financeira de estados incertos com evidência autenticada, política de substituição/reemissão sem duas cobranças cobrando a mesma dívida, e retenção/redação do inbox preservando fingerprint/deduplicação e audit. A conferência entregue não substitui esses itens. Homologação externa continua exigindo conta sandbox/escopos/certificados/callbacks e, depois, autorização específica para produção. Demais PSPs e frentes do backlog permanecem preservados.
