# B07 — base Efí e Pix imediato, incremento local

Estado: **B07 parcialmente implementado**, sem adapter real habilitado. O usuário confirmou interesse em Pix imediato, Pix com vencimento e boleto/Bolix; não são protocolos intercambiáveis. Este incremento entrega transporte Pix sandbox, adapter Cob e journal persistente. Não entrega todos os produtos nem integração operacional pronta.

## Código e limites

- `internal/finance/providers/efi/transport.go`: endpoint sandbox fixo, sem override por env/URL; mTLS TLS≥1.2, par certificado/chave e validade conferidos antes de construir cliente, OAuth por conexão, timeout, cache sincronizado com margem de expiração, bloqueio de redirects/proxy ambiente, corpo limitado e erros sem payload/segredos. Rotação cria outro cliente/transport/cache. Não há certificado ou credencial real no código.
- `immediate.go`: PUT/GET Cob com txid determinístico por tenant/conexão/ambiente/conta/intenção, dinheiro decimal sem float, validação de chave/txid/valor/estado e pagamentos. Datas da fatura não se convertem silenciosamente em expiração Pix. A expiração é configuração explícita; CobV será separado. Resposta concluída sem detalhes de recebimento e devoluções exigem revisão, não geram baixa presumida.
- `internal/finance/issuance.go` + migração 68: uma intenção imutável por fatura, JSON do pedido e hash da configuração de cobrança (não credenciais); incerteza comitada antes de chamar adapter fora da transação. Após erro/reinício, somente consulta da mesma intenção; mesmo 404 não libera nova escrita. Concorrentes conferem o ID persistido. RLS oculta outros tenants, portal e POP restrito. Sem DELETE/downgrade destrutivo.
- Registry `providers.Executable`, restrição SQL de ativação em `financial_connections` e rotas continuam fechados para Efí. O novo serviço é uma fronteira interna, não uma autorização HTTP. Nenhum job ou endpoint de produção o invoca. Não registra pagamento nem vincula automaticamente a resposta à fatura.

O hash de configuração do adapter inclui produto, chave Pix e expiração. Trocar credencial/certificado não muda a intenção; trocar semântica de cobrança requer revisão. Não guardar certificado, senha OAuth ou token no journal.

## Recuperação

`prepared → uncertain → issued` é o caminho automático. `review` é terminal reservado para decisão explícita; ainda não há tela/endpoint de resolução. Uma falha depois do commit de uncertain e antes do envio pode exigir intervenção: não presumir que 404 prova ausência de efeito. `issued` significa resposta identificada no journal, não recebimento ou equipamento liberado.

Migração 68 é aditiva e não altera faturas, pagamentos, movimentos ou efeitos anteriores. Retorno de código conserva o journal; não executar down destrutivo nem resetar uncertain para prepared. Bundle/tag pré-B07 e teste de dump/restauração lógica sustentam recuperação local. Isso não homologa PITR, restore físico ou produção.

## Testes e reprodução

Usar apenas PostgreSQL descartável e variável `NEXO_GO_TEST_DATABASE_URL` do laboratório:

- `go test -race -count=1 ./internal/finance ./internal/finance/providers/...`
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/provider_issuance_migration.py`
- `python3 tests/contrato/nativo.py` e geração `sqlc generate`.

HTTP adverso roda em TLS/mTLS loopback com certificados gerados no teste; nenhum teste consulta a conta Efí. O teste do journal usa banco real descartável e adapter sintético; recria o serviço, não afirma SIGKILL do processo Efí. Testes de integração são pulados sem DB por convenção do projeto; na evidência deste incremento o DB foi fornecido e não houve skips.

## Próximo fechamento interno antes de ativação

1. Ligar journal a autorização financeira e faturamento com vinculação atômica da resposta; impedir alteração/baixa/cancelamento/troca de banco durante emissão pendente. A checagem atual anterior ao envio não fecha a janela entre commit e chamada externa: nenhuma ativação é permitida antes dessa proteção.
2. Receiver Efí com validação mTLS da cadeia esperada, inbox durável, consulta autoritativa e contabilização idempotente. Não reutilizar HMAC demo como autenticação Efí.
3. Cancelamento/devolução: intenção própria, confirmação por consulta e lançamentos de reversão, sem confundir solicitação em processamento com devolução liquidada.
4. Pix CobV (dados devedor/vencimento/encargos) e boleto/Bolix (API Cobranças, autorização e notificações próprias). Todos mantidos no escopo; SDK/protocolo Pix não prova compatibilidade Bolix.
5. Cofre/versão de credenciais por conexão, política de rotação e circuit breaker/Retry-After no consumidor, recuperação após encerramento real do processo e e2e do fluxo conectado.
6. Só então sandbox externo com conta/certificado/chave/escopos apropriados e homologação por produto. Produção continua fora da autorização.

Fontes primárias conferidas em 26/10/2026: [credenciais Pix](https://dev.efipay.com.br/docs/api-pix/credenciais/), [Cob imediato](https://dev.efipay.com.br/docs/api-pix/cobrancas-imediatas/), [gestão de Pix](https://dev.efipay.com.br/docs/api-pix/gestao-de-pix/). SDK local da auditoria lido para comparação; implementação nova sem importar os defeitos de tratamento de certificado/JSON/cache. Arquivos e hashes inspecionados no `sources.json` do lote.
