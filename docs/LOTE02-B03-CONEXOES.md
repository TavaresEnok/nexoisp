# B03 — conexões financeiras isoladas

Implementado e testado localmente em 26/10/2026, no checkout oficial
`/home/enok/Documentos/projetos/NexoISP`, branch
`dev/lote01-consolidado-2026-10-26`. A tag `base/pre-b03-2026-10-26` preserva o
lote anterior. Sem push, implantação ou acesso a contas/equipamentos produtivos.

## Contrato e limites

A conexão identifica tenant, empresa (ou escopo explicitamente sem empresa),
fornecedor, ambiente e referência da conta. A identidade é imutável. Criar outra
conta ou mudar empresa/ambiente exige nova conexão; não retargetear cobranças
existentes. A troca de padrão é transacional e afeta somente próximas emissões.

Somente `demo` em `sandbox` pode ser ativado, com modo demonstração habilitado e
credencial configurada. Efí/sejaefi é normalizado para `efi`; Asaas, Inter,
Sicredi, Mercado Pago, PagBank/PagSeguro, Stripe, Kobana, Shipay e Tuna podem ser
cadastrados como pendentes. Isso não implementa, contrata ou homologa adapters.
A migração também impede ativação real diretamente no banco.

Rotas de gestão, protegidas por `settings:manage` e escopo completo do tenant:

- `GET /api/financial-connections`: metadados, nunca segredo/cifra.
- `POST /api/financial-connections`: name, company_id (UUID ou null), provider,
  environment (`sandbox`/`production`), account_ref, is_default opcional e
  webhook_secret opcional (mínimo 32 caracteres); nasce `pending`.
- `PATCH /api/financial-connections/:id`: status e is_default opcional.
  Ao escolher um padrão, o anterior perde somente essa indicação, sem perder
  referências/histórico. Não habilita provider real.
- `GET /api/financial-connections/pending`: origem de conta não comprovada nos
  registros históricos visíveis ao tenant. Não revela payload/credenciais.

Interface: Administração → Integrações → Conexões financeiras, usando os
componentes oficiais existentes. POP restrito e portal não gerem conexões. Um
operador financeiro de POP pode cadastrar fatura visível, sem consumir a
credencial de conta: a emissão fica para o contexto completo de cobrança. A
baixa manual continua protegida pela intenção do lote 01.

## Webhook demonstrativo

`POST /api/webhooks/gateway/demo` agora exige `X-Nexo-Connection: <UUID>`.
A assinatura é `sha256=<hex HMAC-SHA256(secret, timestamp + "." + connection_id
+ "." + raw_body)>`, nos headers `x-nexo-timestamp` (segundos Unix, tolerância de
300 segundos) e `x-nexo-signature`. Assinar os bytes enviados, não JSON reserializado.
O header da conexão também é autenticado. Os campos tenant/conta do payload
não selecionam o destino. O segredo de uma conexão não autentica outra.

Conexões demonstrativas legadas usam o segredo de demonstração preexistente;
a assinatura inclui a identidade da conexão mesmo nesse caso. Novas conexões
usam seu próprio segredo cifrado. `rotate-secrets` e `verify-restore` incluem
`financial_connections.webhook_secret_enc` na rotação/conferência AES existente.
Não usar o contrato demonstrativo como protocolo de Efí/Asaas/Inter etc.; B06
precisa definir/verificar cada adapter real.

Sem conexão UUID: 400. Assinatura inválida: 401. Conexão ausente/inativa ou
provider não habilitado: 404. Mesmo event_id com conteúdo diferente, ou mesmo
payment_id para outra fatura/valor: 409. Esses erros não criam pagamento.

Cobrança ausente na conexão: evento persistido como `unmatched` e HTTP 200.
Reenvio do mesmo evento pode processá-lo depois que a cobrança correta existir.
Nunca procurar a cobrança em outra conexão. Evento já processado é `duplicate`.
Evento, pagamento e resultado ficam na mesma transação. Consultas de conciliação,
histórico da fatura e lista de eventos usam a conexão, inclusive no simulador.

O botão de pagamento demonstrativo usa o contexto ERP autenticado e confirma
que a conexão está ativa antes de alterar o simulador. Não é um callback externo
sem autenticação. Recebimento desacoplado de comando de rede continua no B05.

## Migração 65 e recuperação

A migração adiciona tabelas/vínculos/FKs/RLS. Backfill automático somente de
registros demonstrativos com fatura comprovada. Dados de conta real desconhecida
não são inferidos pelo nome do gateway. `financial_connection_pending` lista os
vínculos não provados; eventos sem tenant continuam exigindo revisão administrativa
fora do escopo de um tenant. Nenhuma associação automática de ambíguos foi criada.

Índices únicos por conexão são construídos antes de remover índices globais.
Linhas históricas sem conexão conservam índices únicos próprios; não são
apagadas. Leituras legadas continuam separadas das conectadas por comparação
null-safe e tenant. Triggers impedem descarte de conexão histórica, mudança de
identidade e vínculos com empresa/provider/fatura incompatíveis. As funções
antigas de lookup/inbox global perdem permissão do papel da aplicação.

O Down recusa apagar conexões/IDs financeiros. Antes de qualquer futura troca:
pausar escrita/consumidores, capturar snapshot coerente, conferir os pendentes,
validar a migração com cópia autorizada e atualizar aplicação/clientes juntos.
O binário antigo não é compatível com o novo contrato/índices. Recuperação exige
restauração isolada, retenção dos eventos/recebimentos posteriores ao snapshot e
reconciliação antes de replay. Não reativar o binário antigo com escrita liberada.

Testes executados: 64→65 com dados anteriores e intenção 64; reexecução; recusa
de downgrade/lookup global; 32 callbacks concorrentes em duas APIs; IDs iguais
por conta/tenant/empresa/ambiente; assinatura, RLS, histórico e conciliação;
restauração em outro banco, autenticação cifrada e replay após reinício.
O ensaio não comprova restauração física, PITR/failover ou RPO/RTO de produção.

## Regressões reproduzíveis e continuidade

- `tests/contrato/nativo.py` executa os cenários B02 e
  `financial_connections.py`, inclusive restauração de credenciais B03.
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/financial_connections_migration.py`
  cria e encerra PostgreSQL próprio; é um passo separado de `native.yml`.
- `e2e/frontend-v0-financial-connections.mjs` verifica cadastro, ativação,
  padrão, desativação, recarga e ausência de segredo na resposta. Integra smoke.
- SQL gerado com sqlc 1.31.1; duas gerações consecutivas idênticas. A regeneração
  inclui projeções/modelos novos e sincroniza a consulta preexistente de lista
  de assinantes (sem chamador Go ativo desse método), sem redesenhar a interface.

Evidências/resultados completos e commits: relatório
`../../resultados-analise-nexoisp/16_IMPLEMENTACAO_B03.md`.
Próximo lote financeiro: B04, revisar movimentos/alocações e shadow-read antes
qualquer corte; depois B05 e B06. Rede permanece B10 sintético → B09 ACS → B11,
com dependências e homologação externa separadas. Não iniciado por este lote.
