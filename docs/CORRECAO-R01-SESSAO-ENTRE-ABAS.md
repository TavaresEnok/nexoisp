# R01 — sessão entre abas

## Confirmação anterior

`http.ts` repetia o comando ao receber 403 de CSRF, buscando `/me` sem comparar identidade; o teste antigo esperava sucesso após A→B. O `SessionProvider` escutava apenas expiração e sua chave não incluía POP ou MFA. CSRF deriva do cookie, portanto não detecta alterações de autorização na mesma sessão.

## Escolha técnica

`/me` fornece marcador opaco do contexto autorizado e da sessão, calculado no servidor sobre usuário, tenant, suporte, papel, permissões, módulos, POPs, MFA, assinante e células. O cliente só o adota após validação pelo provider. Antes de cada escrita, lê `/me` e exige mesmo marcador e CSRF; envia ambos como precondição. O middleware carrega o contexto diretamente do loader, evitando entrada de cache pendente de invalidação, compara o marcador antes do handler e responde 409 em divergência. Leituras autenticadas também enviam a precondição e verificam o marcador da resposta; divergências, CSRF recusado e 401 invalidam a sessão, desmontam a árvore e substituem o cache. O cabeçalho é precondição, não credencial; CSRF, autorização e RLS continuam em vigor. Para compatibilidade, clientes antigos sem cabeçalho mantêm o comportamento anterior; o cliente novo sempre o envia para rotas protegidas.

Uma nova sessão, mesmo do mesmo usuário e escopo, exige entrada explícita: o marcador inclui a sessão. Não há retry automático, inclusive em rotação de CSRF; o usuário refaz a operação. Ações explícitas de login, suporte e configuração MFA continuam usando `reload` do provider para aceitar o novo contexto e remontar a árvore. Não se usa storage, BroadcastChannel ou token como prova de identidade.

Na recuperação da revisão, o provider inicia a transição HTTP e desmonta a árvore autenticada em um commit de carregamento antes de consultar `/me`. Somente depois aceita a prova e monta a nova árvore e seu cache. A geração anterior é isolada durante toda a consulta: respostas e pré-checagens antigas são recusadas sem cancelar a transição nem invalidar a prova recém-aceita. Uma resposta 401 da geração corrente continua invalidando a sessão. O cenário real verifica `/today` do shell com SWR no login e no reload, prepara um prospecto persistido exclusivo de alfa e recupera beta pelo formulário já exibido. No mesmo documento, segura a resposta real de beta para a mesma consulta da lista e verifica a ausência do registro de alfa antes de liberar a rede e abrir o formulário novo.

## Verificação e limites

| Comando | Resultado |
| --- | --- |
| `node node_modules/tsx/dist/cli.mjs --test apps/web/tests/erp-http.test.ts` | NOTRUN, exit 127: Node ausente no PATH. |
| `npm -w apps/web run typecheck` | NOTRUN, exit 127: Node ausente. |
| `npm -w apps/web run build` | NOTRUN, exit 127: Node ausente. |
| `node --check e2e/frontend-v0-session-cross-tab.mjs` | NOTRUN, exit 127: Node ausente. |
| `git diff --check` | PASS, exit 0. |
| `go -C apps/api-go test ./internal/auth -run '^TestR01AuthContext' -count=1` | PASS, exit 0 com `PATH=/usr/local/go/bin:$PATH` e `GOTMPDIR="$PWD"`; tentativa inicial no PATH padrão exit 127, e `/tmp` não permitiu executar binário de teste. |

Na execução posterior do controlador, os cinco checks web/sintaxe/diff acima passaram (exit 0). O teste Go no runner falhou antes de compilar (exit 1): `GOPROXY=off` e cache de módulos vazio. O PASS Go da tabela refere-se à execução anterior relatada, não ao runner posterior. Nesta recuperação, Node e Go não estão no PATH; `go -C apps/api-go mod download` e os demais checks não foram repetidos nesta sessão. O controlador deve aquecer o cache e executar novamente o check Go.

O cenário de duas páginas e tenants sintéticos está preparado para laboratório real e produz JSON sanitizado somente após sucesso. Não foi executado aqui: não há evidência de navegador, PostgreSQL ou isolamento real nesta entrega. O cenário cria um prospecto sintético no tenant beta e pressupõe laboratório descartável. A revisão independente e a validação integrada cabem ao controlador.

Nesta recuperação após revisão, uma rodada dos comandos obrigatórios resultou em: `go -C apps/api-go mod download` e `go -C apps/api-go test ./internal/auth -run '^TestR01AuthContext' -count=1` NOTRUN (exit 127, Go ausente do PATH); teste HTTP, typecheck, build e `node --check e2e/frontend-v0-session-cross-tab.mjs` NOTRUN (exit 127, Node ausente do PATH); `git diff --check` PASS (exit 0). Os recibos anteriores não comprovam estas novas alterações. O cenário real com navegador e PostgreSQL segue NOTRUN; os prospectos sintéticos de alfa e beta permanecem no laboratório descartável.

Na recuperação 7, após corrigir o início da transição e a verificação de cache no mesmo documento, foram tentados novamente os comandos obrigatórios: `go -C apps/api-go mod download` e `go -C apps/api-go test ./internal/auth -run '^TestR01AuthContext' -count=1` NOTRUN (exit 127, Go ausente); `node node_modules/tsx/dist/cli.mjs --test apps/web/tests/erp-http.test.ts`, `npm -w apps/web run typecheck`, `npm -w apps/web run build` e `node --check e2e/frontend-v0-session-cross-tab.mjs` NOTRUN (exit 127, Node ausente); `git diff --check` PASS (exit 0). O teste HTTP acrescentado cobre a resposta antiga tanto antes da conclusão de `/me` como após a aceitação, além de 401 corrente. Esses testes e o cenário de navegador não foram executados nesta recuperação; não há nova prova integrada de PostgreSQL ou duas abas.
