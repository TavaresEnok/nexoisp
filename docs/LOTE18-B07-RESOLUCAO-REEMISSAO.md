# B07 — resolução autenticada, reemissão e retenção

A ficha oficial da fatura permite **Resolver com consulta autenticada** e **Preparar reemissão segura**. A API exige finance:write, cookie/CSRF, tenant integral e gate Efí sandbox. Suporte, portal e POP restrito não podem resolver. Somente intenção UUID e motivo são recebidos; conta, credencial versionada, produto, valor e vencimento vêm do journal original. A fábrica operacional é fixa e não aceita URL nem evidência do navegador.

A consulta GET precisa corresponder à intenção, conta, configuração, identidade da fatura, BRL e centavos. Timeout, 404, estado vazio, pagamento sem detalhes, divergência, devolução ou operação ainda pendente preservam a reserva. Resultado aceito gera evidência imutável com ator, motivo, versão, estado e SHA-256 do snapshot normalizado, sem guardar dados brutos do pagador nessa evidência. O commit da evidência e dos lançamentos é atômico. Repetição da intenção após perda da resposta lê o resultado persistido; não consulta novamente nem cria outro recebimento. Uma intenção alterada é recusada.

Recebimentos comprovados usam o mesmo lançamento idempotente dos consumidores. Parcial deixa o saldo aberto; integral quita somente o valor comprovado. Estornos, recebimentos locais ausentes da prova, totais divergentes e operações desconhecidas não são liberados por uma conferência administrativa. Resolver não reenvia emissão/cancelamento/devolução. Operações incertas continuam pela recuperação GET já existente.

## Reemissão

A migração77 permite uma cadeia linear de intenções imutáveis sobre **a mesma fatura**, com um único sucessor por predecessor e um único ponteiro atual. Não duplica o nominal nem cancela/apaga a dívida. Cada sucessor exige prova autenticada de remoção com até dois minutos, sem recebimentos/devoluções locais ou remotos e sem operação pendente. Mantém conta, produto, credencial, valor e vencimento. Alterar condições comerciais continua fora dessa ação. A janela interna de recuperação Bolix recebe a data de emissão da nova intenção, definida pelo servidor; a geração antiga conserva sua própria data e hash. Assim uma reemissão semanas depois continua localizável por custom_id após resposta perdida.

Preparar o sucessor não faz POST no fornecedor. O consumidor existente, com seus gates, pode enviar a nova intenção uma única vez. Nova tentativa de envio incerta consulta somente essa intenção. Recebimento ou estorno tardio da geração antiga entra na mesma dívida, mantém conciliação e impede envio ainda não iniciado. Uma leitura antiga sem dinheiro novo não deve recolocar uma geração nova em revisão. Cancelar geração substituída é recusado. Devoluções após reemissão precisam do vínculo auditado do recebimento à geração correta. A projeção evita duplicar recebimentos na seleção de devolução.

QR/boleto são retirados quando a obrigação entra em revisão ou está liquidada. Remoção bancária não garante impossibilidade de liquidação tardia: se o dinheiro chegar depois de um novo envio já confirmado, o ERP mantém o caixa e a revisão; não apaga o pagamento nem inventa cancelamento bancário da nova cobrança. Essa condição exige decisão operacional com prova do fornecedor.

## Retenção

`NEXO_PROVIDER_NOTICE_PAYLOAD_KEEP_DAYS=0` mantém a rotina desligada por padrão. Valor explícito de 30 a 3650 habilita lotes de até 1000 corpos por execução de PURGE; esse número é um limite técnico, não parecer jurídico sobre prazo obrigatório. Apenas avisos processados, antigos e com consulta posterior sem revisão/erro/operação incerta são elegíveis. Pending/unmatched/review e simples ACK são preservados.

O corpo vira `{}` e recebe data de redação. ID, conta, fingerprint, estado, datas e histórico/auditoria permanecem; a chave de deduplicação não é removida. App não recebe UPDATE direto sobre o corpo. A função SQL restringe tenant/portal/POP, usa search_path fixo e registra lote/IDs na auditoria. Escolha do prazo depende da política do operador; não há expurgo automático de journals, pagamentos ou evidências.

## Verificação e recuperação

Validação dirigida: concorrência e perda de resposta, escopo entre tenants/POP, parcial, reservas pendentes, reemissão, dinheiro/estorno tardios, devolução por geração e deduplicação após redação. Typecheck/build, lint e jornada curta no navegador contra API descartável. O navegador usa credenciais sintéticas com configuração deliberadamente divergente, provando recusa antes de qualquer I/O PSP. Testes de sucesso financeiro usam adapters sintéticos: **C/T locais; nenhuma homologação bancária ou produção**.

Upgrade76→77 preservou snapshots de faturas, pagamentos, journals, movimentos e efeitos, inclusive uma cobrança emitida com recebimento parcial. Prepare repetido e dump lógico restaurado em outro banco descartável conferiram os mesmos registros. Isso não comprova restauração integral dos serviços/cofre/equipamentos.

A base de código recuperável anterior é `base/pre-b07-resolution-2026-10-27`. Não executar Down destrutivo: depois que houver sucessores, versões que assumem uma emissão por fatura são incompatíveis. Em recuperação, pausar consumidores/mutações, preservar journals/provas e corrigir adiante; restauração de snapshot anterior só serve se nenhum evento posterior for perdido e após conciliação. Sem implantação nesta etapa.

Permanecem externos: credenciais/ambiente autorizado Efí, semântica e consistência dos produtos homologadas com o fornecedor, política de retenção escolhida pelo operador e tratamento real de liquidação tardia. Permanecem no backlog os demais fornecedores, cenários fiscais/CNAB, rede/ACS/RADIUS, atendimento, estoque, WhatsApp, topologia, migração e restauração/piloto já registrados; este lote não os declara concluídos.
