# Fechamento das correções R01–R09 da revisão de 30/10/2026

Consolidação documental em 31/10/2026. Os nove achados confirmados antes das alterações foram corrigidos em três planos informados pelo controlador como **DONE**, com revisões independentes **PASS**. Os marcos físicos dirigidos posteriores foram executados e observados pela gerência no host. O fechamento se limita a esses nove achados no clone integrado; não declara o sistema 100%, equivalência integral ao SGP, publicação ou prontidão de produção.

O produto examinado na revisão original e o corte oficial/GitHub informado são `3ba3f7634e9623ffc8e30b15c618e2b904e63d13`. As correções estão integradas somente no clone, em `4b1f4f4b25765df0ff4f52911fa5e5e2e7848aed`, HEAD desta tarefa. Não houve push ou deploy das correções. Este documento está pronto para a revisão independente documental pelo controlador; essa revisão é distinta das revisões já aprovadas da implementação.

## Origem e método desta consolidação

Foram consultados os pareceres originais de [produto e operação](revisao-2026-10-30/produto-operacao.md), [financeiro](revisao-2026-10-30/financeiro.md) e [segurança e integrações](revisao-2026-10-30/seguranca-integracoes.md), além dos documentos individuais de correção vinculados abaixo. R01/R03/R06 correspondem a A1/A2/A3 de produto; R02 corresponde a F1 financeiro; R04/R05/R07 correspondem aos três achados priorizados de segurança e integrações. R08/R09 são os recortes autorizados dos leitores financeiros: representação dos agregados e mês civil do provedor, conforme o contrato e seu documento de implementação.

A conferência local foi restrita aos commits e trechos relevantes do código atual: contexto HTTP/autenticação, estorno e consultas de cobertura, intenção de materiais, guard POP RADIUS, sincronizador de accounting, verificador de restore, cliente/journal Cloud e leitores financeiros. Isso confirma a presença das soluções; não constitui nova auditoria nem nova prova dinâmica. Não foram executados Go, npm, PostgreSQL, navegador, CI ou gerador nesta tarefa. Os checks documentais limitam-se a Git diff e à validação JSON/SHA256 da fonte fornecida pela gerência.

O rastreio estático no HEAD integrado corresponde aos arquivos seguintes, sob `apps/api-go/internal/`: R01 em `auth/auth.go` e `auth/context_marker.go`, com cliente `apps/web/data/erp/http.ts` e transição em `apps/web/features/session/provider.tsx`; R02 em `finance/core.go`, `finance/sql/48002566_4.sql` e consultas `f7267ee2_*`/`5a7438b9_0.sql`; R03 em `modules/escrita/materiais.go`, com persistência da intenção em `apps/web/features/field/material-intent.ts`; R04 em `modules/leitura/radius_health.go` e no guard da rota em `dinamicas.go`; R05 em `radius/executor.go` e `radius/sql/2d1c3b4c_2.sql`; R06 em `db/restore.go`; R07 em `outbound/cloudapi/client.go` e `outbound/cloudjournal/journal.go`; R08/R09 em `modules/leitura/finance_readers.go`, `modules/leitura/queries/readf038858e.sql` e `modules/leitura/queries/group3a79e37d_0.sql`, com formatação em `apps/web/features/finance/models.ts`. As migrações aditivas 84–86 estão em `db/migrations` na raiz. Os commits de implementação da tabela constam do histórico local que conduz a `4b1f4f4`; sua presença não comprova publicação remota.

Os resultados físicos abaixo são **relatos de observação da gerência**, agora fornecidos também na fonte separada [S-HOST](evidencias/CORRECOES-R01-R09-HOST.json), existente e lida nesta worktree. O arquivo contém a declaração integral R01, R02, R03_R05 e R06_R09, inclusive `actual_test_action_counts`, e cópias sanitizadas dos recibos primários com SHA256 dos originais. Foi fornecido administrativamente pela gerência, independentemente deste relatório; não foi gerado a partir dele. Os documentos individuais registram etapas anteriores e não comprovam, por si, esses marcos posteriores. Os caminhos externos de recibos são referências locais do observador no host: este executor leu as cópias fornecidas em S-HOST, sem abrir os originais externos nem verificar seus hashes contra esses originais. DONE e PASS das revisões de implementação também são atribuídos ao controlador; não foram reemitidos por este executor.

## Tabela de fechamento dos nove achados

Na coluna resultado, “fechado” significa implementação e revisão aprovadas pelo controlador, acompanhadas da prova dirigida atribuída à gerência. O alcance e os limites fazem parte de cada resultado.

| Item / problema confirmado | Solução presente no código | Commit de implementação | Resultado / revisão / prova atribuída | Limites verificáveis |
| --- | --- | --- | --- | --- |
| **R01 — sessão entre abas:** comando da aba antiga podia ser repetido sob novo cookie/contexto, com formulário e cache anteriores. | Marcador opaco de sessão/autorização emitido pelo Go; precondição `X-Nexo-Context`, conferência antes da escrita, sem retry automático de CSRF; transição desmonta árvore e cache e recusa respostas da geração anterior. | `9f337517a0afd380d4df4f6e99ca9e710f645a8c`; ajuste do cenário integrado em `79ed4d662046fca2b9632afec17c9aa9d1e4c0d6`. | **Fechado; revisão PASS**, plano R01–R02. Gerência: Chromium real, duas abas, cookies compartilhados, Alfa/Beta, mesmo documento/filtro/cache; intenção antiga negada e recuperação consciente PASS após ajuste. Recibo H1. | Clientes antigos sem o cabeçalho conservam a compatibilidade anterior; CSRF, autenticação e RLS continuam necessários. O erro anterior do cenário não é apagado nem contado como PASS. [Detalhes](CORRECAO-R01-SESSAO-ENTRE-ABAS.md) e [ajuste da verificação](CORRECAO-R01-VERIFICACAO-INTEGRADA.md). |
| **R02 — estorno/cobertura:** estorno fixava `open` mesmo com cobertura integral; automação não exigia residual positivo. | Líquido `bigint` comparado a valor + taxa − desconto: abaixo `open`, igual `paid`, acima `reconciling`; `paid_at` coerente; reclassificação não repete efeitos de pagamento. Cobrança/suspensão exigem residual e releitura sob trava. Migração 84. | `28e5b449a2ea5fa71b61a6f7e9254e621d0bcc14`. | **Fechado; revisão PASS**, plano R01–R02. Gerência: dois testes nomeados com PostgreSQL real e `-race`, zero SKIP; obrigação líquida 10500, abaixo/igual/acima, estornos concorrentes e preservação de efeito anterior. H2. | Prova dirigida, sem homologação PSP ou mudança de regra comercial adicional. Reuso posterior dependeu dos 187 hashes financeiros inalterados informados pela gerência; não é nova execução. [Detalhes](CORRECAO-R02-ESTORNO-COBERTURA.md). |
| **R03 — material em OS:** perda da resposta após commit permitia novo débito de estoque. | UUID/payload persistidos antes do envio, coordenados por Web Locks; replay usa a mesma intenção. Backend serializa UUID e retorna recibo persistido na mesma transação do movimento/evento, sob RLS/POP. Migração 85. | `cb91bbb04c6755b95508805ed5a6f34ecffafd5a`. | **Fechado; revisão PASS**, plano R03–R05. Gerência: PG real com race no lote H3 e browser real H4; resposta perdida após commit, reload + mesmo UUID mantém estoque 9; novo UUID leva a 8, PASS. | Sem Web Locks ou persistência local disponível, criação falha antes do envio. Não é banco comercial no navegador nem promessa de operação offline. [Detalhes](CORRECAO-R03-MATERIAIS-IDEMPOTENTES.md). |
| **R04 — saúde RADIUS:** contadores globais do tenant eram expostos a operador restrito a POP. | Rota e métodos de consulta recusam escopo `PopIDs` não nulo, inclusive lista vazia, com 403 antes da transação de instalação. Escopo integral preserva contrato existente. | `d10469be872c0b074e09419801200eacabbc364d`. | **Fechado; revisão PASS**, plano R03–R05. Gerência: marco PG real `-race`, cinco testes nomeados no lote, zero SKIP, H3; cobertura dirigida de escopo/contagens descrita no documento individual. | Solução é recusa do escopo parcial, não implementação de contadores por POP. Não homologa NAS ou política física. [Detalhes](CORRECAO-R04-RADIUS-ESCOPO-POP.md). |
| **R05 — accounting:** delta e baseline em leituras separadas podiam absorver atualização concorrente e perder consumo. | Delta/baseline compartilham fonte materializada; fila transacional de pendências por accounting/tenant cobre commits atrasados. Ordem NAS → marcas, reconhecimento apenas do lote incorporado e watermark após commit. Migração 86. | `e1bc96c09613278549d62fccb3b1621fa9e857f2`. | **Fechado; revisão PASS**, plano R03–R05. Gerência: cinco testes nomeados do lote PG real `-race`, zero SKIP, H3, com schema 85/86. O teste dirigido documenta intercalação, consumidores, atraso, rollback e retomada. | Bootstrap e limites de retenção existentes continuam; marcas sem recurso mapeado aguardam reprocessamento. Não é prova de cobrança por franquia ou homologação física. [Detalhes](CORRECAO-R05-ACCOUNTING-SNAPSHOT.md). |
| **R06 — restore Cloud:** verificador não conferia token e segredo de webhook cifrados. | `verifyRestore` decifra os dois campos Cloud na transação read-only; aceita ausência da tabela pré-79 somente após `to_regclass`; falhas de colunas/leitura/decifragem em tabela presente continuam fatais, sem exposição de segredos. | `ee212c0c8f5f30371ddf8dbb012df833c011d69e`. | **Fechado; revisão PASS**, plano R06–R09. Gerência: oito casos de restore no marco PG real obrigatório com race, H5. | Ensaio sintético do verificador, sem rotação/escrita de segredos; não comprova recuperação de produção, destino externo ou RPO/RTO. [Detalhes](CORRECAO-R06-RESTORE-CLOUD.md). |
| **R07 — redirect Cloud:** cliente recusava 302, mas journal não aceitava a classificação, deixando `wire/sending`. | Recusa explícita 3xx torna-se resultado terminal `refused/failed` com HTTP original e ID nulo; cliente não lê corpo/Location para diagnóstico; journal preserva validações de combinações incoerentes. | `254e54c72f3ccf2bfd908c0326dfdb908618df7b`. | **Fechado; revisão PASS**, plano R06–R09. Gerência: composição cliente → worker → journal e persistência terminal no PG real, H5; transporte local injetado, zero HTTP externo. | Não comprova envio Meta, template, conta ou callback real. Gate Cloud continua fechado e não há reenvio automático do terminal. [Detalhes](CORRECAO-R07-CLOUD-REDIRECT.md). |
| **R08 — agregados financeiros:** casts int32 e conversão numérica podiam estourar ou perder centavos em leituras. | Resumo/série e projeção shadow afetada usam bigint/int64; adaptador local preserva inteiros e rejeita fora de ±9007199254740991 com 422 sanitizado, inclusive série inteira; UI valida inteiro seguro e formata centavos com BigInt. | `70da3f3a50c87795428507b770a9b009a031aafb` (frente compartilhada R08/R09). | **Fechado; revisão PASS**, plano R06–R09. Gerência: PG real obrigatório com race, limites int32/int64/JS, negativos e overflow no marco H5; build integrado H6. | Restrito aos dois leitores e projeção shadow indicada; não corrige globalmente escritores/outros endpoints nem abre B04. Sem novo browser desta rodada. [Detalhes](CORRECAO-R08-R09-LEITORES-FINANCEIROS.md). |
| **R09 — mês financeiro:** corte mensal precisava seguir o mês civil do provedor, independentemente do fuso da conexão. | Resumo/série usam `tenant_settings.timezone`, fallback `America/Sao_Paulo`, intervalo fechado no início e aberto no começo do próximo mês, convertido para timestamptz. | `70da3f3a50c87795428507b770a9b009a031aafb` (mesmo commit de R08). | **Fechado; revisão PASS**, plano R06–R09. Gerência: PG real com ambos os limites mensais e fusos distintos, consistência resumo/série, filtro de empresa e fallback, H5; build H6. | Resumo preserva filtro opcional de empresa; série abrange empresas do provedor. Não altera fórmulas de saldo, autorização ou corte B04. Sem homologação fiscal. [Detalhes](CORRECAO-R08-R09-LEITORES-FINANCEIROS.md). |

## Registro dos marcos observados no host pela gerência

Todos os caminhos a seguir são relativos ao ambiente local da gerência. São referências de procedência, sem alegação de montagem ou leitura dos originais externos pelo executor documental. As cópias sanitizadas fornecidas em S-HOST foram lidas para o confronto documental.

| Ref. | Plano / corte informado | Observação fornecida pela gerência | Referência local do recibo |
| --- | --- | --- | --- |
| H1 | Job `25aba610da55`, R01 com ajuste final `79ed4d662046fca2b9632afec17c9aa9d1e4c0d6` | Chromium real PASS após ajuste; falha anterior de sincronização preservada. | `implementacao-codex/correcoes-revisao-r01-r02-2026-10-31/r01-browser-followup.json` |
| H2 | R02, commit `28e5b449a2ea5fa71b61a6f7e9254e621d0bcc14` | `TestR02ReversalCoverageAndEffects` e `TestR02ConcurrentReversal`, PG real com race, zero SKIP; casos finais de taxa/desconto e efeito anterior cobertos. Reuso posterior com 187 hashes financeiros inalterados. | `implementacao-codex/correcoes-revisao-r01-r02-2026-10-31/r02-reviewed-pg.json` |
| H3 | Job `93437cb47ae2`, head `2fd809fa0725265996e1ade7cad3d246e43cf6b5` | Cinco testes nomeados em PG real com race, zero SKIP; schema 85/86. Falha de preparação de dependências de snapshots preservada; build posterior PASS. | `implementacao-codex/correcoes-revisao-r03-r05-2026-10-31/pg-summary.json` |
| H4 | Mesmo job/head de H3 | Browser R03 real: perda de resposta pós-commit, replay após reload e nova intenção, PASS. | `implementacao-codex/correcoes-revisao-r03-r05-2026-10-31/browser-milestone.json` |
| H5 | Job `dcc1ff749864`, head `4b1f4f4b25765df0ff4f52911fa5e5e2e7848aed` | `PG_REQUIRED=1`, race e todos os `TestR06/7/8/9` aprovados: **9 testes de topo e 42 ações PASS de testes + subtestes**, zero FAIL, zero SKIP. Inclui oito casos restore, composição redirect/journal terminal e limites financeiros/mensais. Transporte local injetado, zero HTTP externo. | `implementacao-codex/correcoes-revisao-r06-r09-2026-10-31/pg-summary.json` |
| H6 | Mesmo head combinado de H5 | `npm -w apps/web run build`, exit 0, tsc + Vite. Sem reexecução de UI no navegador para este lote. | `implementacao-codex/correcoes-revisao-r06-r09-2026-10-31/frontend-milestone.json` |

As 42 ações não são 42 testes de topo nem uma contagem da suíte inteira. Os cinco testes de H3 são contagem do lote, sem atribuição de cinco testes a cada achado. PASS com zero SKIP nesses marcos posteriores não converte os SKIP/NOTRUN anteriores em sucesso retroativo.

### Fonte S-HOST: arquivo separado fornecido pela gerência

A revisão documental anterior (**FAIL6**, P2) não aprovou o pacote porque a mensagem HOST disponível ao revisor terminava durante R01, em `PASS; fi`, e não sustentava a conferência de H2–H6. A causa informada pelo controlador foi o recorte do objetivo geral a 2000 caracteres por `core.prompt_for` na fase REVIEW. Esse parecer permanece histórico: apontou insuficiência do pacote, sem concluir que os marcos falharam ou que o executor não recebeu a declaração completa.

A fonte completa agora é o arquivo separado [docs/evidencias/CORRECOES-R01-R09-HOST.json](evidencias/CORRECOES-R01-R09-HOST.json), fornecido pela gerência em 31/10/2026, com SHA256 obrigatório `edad17cc6a9676b37881eb62f0e4fcd6dc7af5a1d474ce82c96acd843cba60c0`. Seus bytes são preservados na entrega. O conteúdo foi lido e confrontado com a tabela e H1–H6: `declaration` contém os quatro blocos integrais, e `primary_receipts` contém as cópias sanitizadas e os hashes identificadores dos originais no host. Validar o hash do arquivo fornecido não autentica por execução independente os marcos nem implica acesso aos originais externos.

O revisor deve ler diretamente esse arquivo separado antes do parecer e confrontar `R01` com H1, `R02` com H2, `R03_R05` com H3/H4 e `R06_R09` com H5/H6, incluindo os 187 hashes financeiros informados e as contagens `pass: 42`, `toplevel: 9`, `skip: 0`, `fail: 0`. Os jobs são `25aba610da55`, `93437cb47ae2` e `dcc1ff749864`, com head final `4b1f4f4b25765df0ff4f52911fa5e5e2e7848aed`. O confronto não depende de mensagem futura, objetivo geral sem recorte ou acesso ao host. A declaração e os recibos fornecidos continuam sendo evidência atribuída à gerência, sem reexecução independente pelo autor ou revisor documental.

**A cópia JSON abaixo é apenas redundância de leitura, não fonte independente para revisar o relatório.** A fonte para revisão é o arquivo S-HOST separado já disponível. A entrega documental está pronta para revisão, sem antecipar seu resultado; o FAIL6 e as provas históricas permanecem preservados. Não há impedimento de implementação documental nem necessidade de reexecutar produto.

```json
{
  "R01": {
    "job": "25aba610da55",
    "commit": "9f337517a0afd380d4df4f6e99ca9e710f645a8c",
    "verification": "Real Chromium two tabs, shared cookies, Alfa/Beta, same document/filter/cache, old intent denied and conscious recovery PASS; final test adjustment79ed4d662046fca2b9632afec17c9aa9d1e4c0d6; browser after adjustmentPASS, prior failure preserved",
    "receipt": "implementacao-codex/correcoes-revisao-r01-r02-2026-10-31/r01-browser-followup.json"
  },
  "R02": {
    "commit": "28e5b449a2ea5fa71b61a6f7e9254e621d0bcc14",
    "verification": "RealPG -race2namedtests zeroSKIP, fee/discountnet10500, below/equal/above, concurrentreversals, prior-effectpreservation; subsequent unchangedfinance187hashes reuses proof",
    "receipt": "implementacao-codex/correcoes-revisao-r01-r02-2026-10-31/r02-reviewed-pg.json"
  },
  "R03_R05": {
    "job": "93437cb47ae2",
    "head": "2fd809fa0725265996e1ade7cad3d246e43cf6b5",
    "commits": {
      "R03": "cb91bbb04c6755b95508805ed5a6f34ecffafd5a",
      "R04": "d10469be872c0b074e09419801200eacabbc364d",
      "R05": "e1bc96c09613278549d62fccb3b1621fa9e857f2"
    },
    "verification": "RealPG -race5namedtests zeroSKIP; actual browserR03 commitresponse lost, reload+sameUUID replaystock9 and newUUIDstock8PASS; schema85/86; snapshotsdepssetupfailurepreserved then buildPASS",
    "receipts": [
      "implementacao-codex/correcoes-revisao-r03-r05-2026-10-31/pg-summary.json",
      "implementacao-codex/correcoes-revisao-r03-r05-2026-10-31/browser-milestone.json"
    ]
  },
  "R06_R09": {
    "job": "dcc1ff749864",
    "head": "4b1f4f4b25765df0ff4f52911fa5e5e2e7848aed",
    "commits": {
      "R06": "ee212c0c8f5f30371ddf8dbb012df833c011d69e",
      "R07": "254e54c72f3ccf2bfd908c0326dfdb908618df7b",
      "R08_R09": "70da3f3a50c87795428507b770a9b009a031aafb"
    },
    "verification": "RealPG PG_REQUIRED1 -race allTestR06/7/8/9 pass;9topleveltests and42test+subtestpassactions,0fail0skip; restore8cases+redirectcomposition/terminaljournal+int32/int64/JSsaferange/negative/bothmonthboundaries; localinjectedtransport zeroexternalHTTP. npm -w apps/web run build exit0 exactcombinedhead (tsc+vite), noUIbrowserrerun forthisbatch",
    "receipts": [
      "implementacao-codex/correcoes-revisao-r06-r09-2026-10-31/pg-summary.json",
      "implementacao-codex/correcoes-revisao-r06-r09-2026-10-31/frontend-milestone.json"
    ],
    "actual_test_action_counts": {
      "pass": 42,
      "toplevel": 9,
      "skip": 0,
      "fail": 0
    }
  }
}
```

## Histórico, publicação e limites de operação

Os documentos individuais mantêm seus recibos de tentativas, ausência de ferramentas/URLs, falhas de preparação, skips e recuperações. Em particular, a falha do cenário R01 e os conflitos de asserções de R08/R09 continuam registrados; a recuperação autorizada dos guards de regressão consta do documento individual. Esta consolidação acrescenta os resultados posteriores atribuídos ao controlador e à gerência, sem apagar provas originais, falhas ou revisões.

| Dimensão | Estado deste fechamento |
| --- | --- |
| Implementação | R01–R09 presentes no clone integrado `4b1f4f4`; commits preservados. |
| Revisão da implementação | Três planos DONE e revisões independentes PASS, conforme controlador. |
| Testes | Marcos dirigidos locais/host acima, atribuídos à gerência; nenhuma suíte de produto reexecutada pelo executor documental. |
| Revisão deste relatório | Próxima fase independente do controlador; arquivo pronto para revisão mediante leitura direta da fonte separada S-HOST fornecida nesta worktree e confronto com a tabela e H1–H6. O FAIL6 documental anterior não é convertido em PASS. |
| Publicação | Oficial/GitHub informado permanece `3ba3f76`; correções sem push/deploy. |
| CI hospedada | Nenhuma execução nova destas correções. CI histórica não comprova o novo head. |
| Produção | Sem acesso, implantação ou homologação de produção nesta entrega. |

Continuam pendentes protocolos e contas externos, Efí, WABA e templates, fiscal, bancada NAS/ACS/OLT, piloto operacional, dados autorizados de migração e definição/prova de destino externo de backup e RPO/RTO. Cloud exige protocolo operacional além de credencial ou flag: conta/versão/template, fluxo de envio e callback precisam de comprovação própria. **Gates B04 e Cloud continuam fechados**; as correções não autorizam ativação financeira, Meta ou hardware. Chatwoot permanece fora deste escopo, em outro projeto.

O [relatório geral preexistente](RELATORIO-GERAL-DESENVOLVIMENTO-2026-10-30.md) e os três pareceres de 30/10 permanecem preservados. O [plano de integração](integracao-v0/PLANO.md) e a [matriz funcional](integracao-v0/MATRIZ_FUNCIONAL.md) continuam sendo as referências para o estado da migração; esta tarefa não refaz a matriz, não revalida a etapa 7 e não reabre tarefas históricas. A interface oficial v0 e as regras comerciais existentes permanecem fora de alteração.

O fechamento dos nove achados não mede cobertura funcional global ou equivalência a outro ERP. A estimativa de **85–90%** mencionada em chat é informal, sem medição formal, e **não é prova deste relatório**. Não foi calculada outra porcentagem. Nenhuma regra comercial nova, funcionalidade, auditoria geral ou teste de produto foi acrescentado nesta tarefa.

Validação documental desta retomada: Git diff e parsing JSON/SHA256 da fonte S-HOST, com resultados registrados em `.paseo-result.json`. `git diff --check` verifica alterações rastreadas; `git diff --no-index --check /dev/null docs/CORRECOES-REVISAO-2026-10-30.md` abrange o relatório ainda não rastreado, sem incluí-lo no índice. O parsing e a comparação com o SHA256 obrigatório verificam a integridade do insumo fornecido. Esses checks não comprovam testes de produto, execução HOST ou aprovação independente.
