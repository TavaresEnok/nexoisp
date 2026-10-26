# B07: credenciais, produtos e recebimento sandbox

Estado de 26/10/2026. Este incremento implementa e testa o pipeline local de Pix imediato, Pix com vencimento e boleto/Bolix. **B07 completo permanece parcial**: cancelamento/devolução operacional, UI de emissão/revisão, notificações de Cobranças e homologação ainda não foram concluídos. Não houve chamada autenticada a uma conta Efí, implantação ou alteração de equipamento.

## Fronteiras implementadas

| Parte | Código | Comportamento verificado |
|---|---|---|
| Cofre versionado | `internal/finance/credentials.go`, `escrita/financial_credentials.go`, migração 70 | Cifra autenticada pelo mecanismo existente; envelope vincula tenant/conta/versão. Metadados públicos, coluna cifrada sem SELECT geral para o papel da aplicação. Rotação serializa na conexão. |
| UI de credenciais | `apps/web/features/admin/financial-credentials.tsx` | Usa Dialog/Input/MutationForm oficiais. Arquivos PEM e senha enviados pela sessão/CSRF existentes; não persistidos em localStorage/sessionStorage. Reabertura mostra versão e validade, sem retornar segredo. |
| Produtos | `providers/efi/immediate.go`, `due.go`, `bolix.go` | Cob e CobV usam OAuth Pix/mTLS; Bolix usa API Cobranças/OAuth distinto. Endereços sandbox fixos, TLS verificado, sem URL de transporte configurável pelo usuário. |
| Intenção e envio | `issuance.go`, `dispatch.go`, migrações 69–71 | Reserva e auditoria atômicas; sem HTTP na preparação. Incerteza gravada antes da chamada. Retomada consulta, inclusive após perda da resposta; nunca repete POST de Bolix automaticamente. |
| Recebimento | `provider_receipts.go` | Consulta autoritativa confirma conta/título/centavos/data; reaproveita Payment e efeito durável B05. Concorrência não duplica caixa/efeito. ID recebido com dados diferentes preserva dinheiro original e exige revisão. |
| Callback Pix | `internal/psphook/server.go`, `provider_notices.go`, migração 72 | Listener TLS separado exige certificado cliente verificado e chave pública fixada. Headers de certificado não substituem TLS. Inbox antes da resposta; aviso antecipado/repetido só agenda consulta, nunca baixa pelo valor do payload. |
| Retomada de revisão | `provider_review.go`, `escrita/provider_issuance.go` | Requer finance:write, escopo completo e motivo auditado. Review volta a uncertain, jamais prepared. Divergência de recebimento pode agendar nova consulta sem apagar histórico/valor ou declarar revisão resolvida. |

Os caminhos Go abreviados são relativos a `apps/api-go/internal/`. O tipo interno `PixCredentials` também representa credenciais da API Cobranças pelo campo `kind`; ele nunca constitui contrato de resposta com segredos.

## Contratos e autorização

- GET/POST `/api/financial-connections/{id}/credentials`: `settings:manage`, tenant completo, sem portal/POP. GET retorna apenas versões, tipo e validade/fingerprint. Mudança de API exige outra conexão.
- POST `/api/financial-connections/{id}/issuance`: `finance:write`, tenant completo. Backend deriva empresa, valor e vencimento da fatura; `invoice_id`, `intent_id` e opções de produto são validados. Conexão Efí sandbox ativa e versão válida obrigatórias. Tentativa de outro intent na fatura reservada recebe 409.
- GET `/api/financial-connections/{id}/issuance/{issuanceId}`: `finance:read`, tenant completo, metadados operacionais sem credenciais/devedor.
- POST na mesma emissão com `/retry-lookup`: `finance:write`, tenant completo e motivo de 10–500 caracteres. Não autoriza criar cobrança nem altera caixa.
- POST `/callbacks/efi/{connection}/pix` e probe na URL base: exclusivamente no listener mTLS. O tenant vem do diretório da conexão, não de headers/corpo. A aplicação pública não recebe esse callback como se fosse um webhook demonstrativo.

A intenção congela credencial e semântica de pagamento (incluindo chave Pix). O transporte usa a versão atual para permitir rotação de OAuth/certificado, sem reescrever a cobrança anterior. Uma credencial de API Cobranças não pode ser usada como credencial Pix ou vice-versa. Elegibilidade bancária do certificado não é comprovada pela validação criptográfica local.

Bolix pesquisa `custom_id` em janela de datas congelada pelo servidor. Ausência, resultado múltiplo ou identidade divergente mantém incerteza/revisão. `custom_id` não é tratado como garantia de unicidade do PSP. Baixa `settled` não vira recebimento bancário inventado. `paid_value` confirmado é distinto do nominal; data de pagamento sem fuso ou valor ausente causa revisão. Formatos de documentos suportados aqui são CPF e CNPJ numéricos; CNPJ alfanumérico ainda requer implementação/teste específico.

## Gates: todos os novos consumidores desligados por padrão

Nenhum dos valores abaixo foi aplicado a produção. Os quatro defaults em `infra/prod/docker-compose.yml` são `0`; alterar esse arquivo não executa compose/deploy.

| Variável | Finalidade |
|---|---|
| `NEXO_GO_EFI_SANDBOX_ENABLED=1` | Permite validação/ativação sandbox e processamento. Não permite ambiente production. |
| `NEXO_GO_JOB_PSP_ISSUANCE=1` | Agenda o consumidor de emissão/recuperação. |
| `NEXO_GO_EFI_DISPATCH=1` | Permite novos claims de intenções prepared em contas ativas. Com `0`, consumidor habilitado continua consultando uncertain, inclusive em contas desativadas. Não cancela chamada já em andamento. |
| `NEXO_GO_JOB_PSP_RECEIPTS=1` | Agenda consultas de títulos issued em contas ativas ou desativadas; independente do gate de novos envios. |

O cofre exige `NEXO_SECRET_KEY` persistente explicitamente configurada; a chave efêmera de desenvolvimento não é aceita para novas credenciais. Não há segredo/certificado bancário no repositório. O listener de callback só existe com `NEXO_GO_EFI_WEBHOOK_ADDR`, `NEXO_GO_EFI_WEBHOOK_CERT`, `NEXO_GO_EFI_WEBHOOK_KEY` e `NEXO_GO_EFI_WEBHOOK_PROVIDER_CERTS`. O último arquivo deve conter o certificado público do cliente Efí a fixar e sua cadeia confiável, obtidos/validados fora do produto. Bundle só de CA não comprova a chave do cliente. Não há fallback para HTTP ou `skip-mTLS`. Roteamento TLS externo e registro do webhook na conta não foram operados.

## Migração e recuperação

70 adiciona cofre/FKs/RLS e ponteiros de versão; 71 adiciona produto/opções, estatísticas de envio/consulta e transições controladas; 72 adiciona inbox. Intenções legadas sem credencial permanecem sem credencial, excluídas do despacho automático. Nenhum backfill escolhe uma nova conta/credencial para uma emissão incerta antiga.

O teste `provider_pipeline_migration.py` instala 69, cria reserva incerta, atualiza duas vezes até 72 e compara histórico financeiro; cadastra duas versões sintéticas; gira a chave mestra e repete a intenção com somente a chave nova; restaura dump em outro banco, verifica descriptografia, replay autenticado e recusa de chave errada. Down destrutivo das três migrações é recusado. O teste histórico 68→69 agora fixa o alvo 69, preservando suas assertivas.

`rotate-secrets` e `verify-restore` incluem o novo cofre. Recuperação exige chaves separadas do dump, build compatível com schema 72 e consumidores mutantes pausados até conferir estado remoto. A tag anterior recupera código, não autoriza baixar o schema nem operar código 69 contra novos consumidores/dados. O ensaio foi de restauração lógica; não comprova host novo completo, arquivos/documentos, PITR, contingência bancária ou restauração física de equipamento.

## Testes afetados

- `python3 tests/contrato/go_integration.py`: PostgreSQL novo e próprio; todos os pacotes Go com race. Pacotes em série (`-p 1`) porque o teste de jobs injeta fuso inválido no mesmo tenant; concorrência de goroutines permanece testada. Não confundir pacotes sem testes com testes pulados.
- `python3 tests/contrato/nativo.py`: duas APIs reais, RLS, reserva/idempotência B02, caixa B04/B05 e subprocesso adicional com preparação habilitada mas despacho desligado. Inclui `financial_credentials.py` com rotações concorrentes, três produtos, falha atômica de auditoria e retomada de revisão.
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/provider_pipeline_migration.py`: upgrade/rekey/restauração lógica isolados.
- `npm ci`, format, typecheck, testes e build em Node 22; navegador em três jornadas afetadas mais perda de resposta B02.
- Testes de transporte usam somente loopback e certificados sintéticos. Não existe flag do produto para selecionar o transporte dos testes.

Logs e contagens exatas ficam fora do checkout em `implementacao-codex/lote08-b07-continuacao-2026-10-26/evidencias/`. Relatório consolidado: `resultados-analise-nexoisp/22_IMPLEMENTACAO_B07_PIPELINE.md`.

## Pendências reais

Internas B07: journal e execução segura de cancelamento/devolução; alocação de devoluções parciais após revisar dependências do estorno integral atual; UI oficial para emitir/consultar/revisar com intenção persistente; notificação da API Cobranças por consulta de token; política de retenção e operação do inbox; registro/configuração operacional do webhook. Reagendar consulta não equivale a resolver divergência, cancelar dívida ou devolver dinheiro.

Externas: conta separada sandbox Efí, produtos/escopos habilitados, credenciais/chave/certificados e origem TLS autorizada, homologação por produto e evidências efetivas da API. H e P não executados. Nenhuma pendência interna acima foi reclassificada como dependência bancária.

Depois do fechamento interno B07, rede segue B10 (hostkeys/driver, resultado desconhecido, readback) → B09 (propriedade/task ACS) → B11 (AAA/CoA/accounting). B08 e os demais PSPs continuam delimitados por demanda. B12 preservado; B13–B18 e atendimento/OS/estoque continuam no backlog integral, sem novo inventário.
