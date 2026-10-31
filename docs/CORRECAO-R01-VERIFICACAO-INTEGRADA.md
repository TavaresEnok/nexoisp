# R01 — sincronização do cenário integrado

Na execução integrada da gerência, `node e2e/frontend-v0-session-cross-tab.mjs` terminou com exit 1: `route.continue: Route is already handled!` na linha 62. O handler aguardava a liberação de uma requisição real de leads, mas a rota era desregistrada antes de sua conclusão; o erro não tratado também podia encobrir uma falha anterior de asserção no cleanup. Essa execução não comprova isolamento entre sessões.

A correção mantém cada handler responsável por uma única chamada a `route.continue()`, acompanha sua conclusão e libera e aguarda os handlers antes de desregistrar a rota e fechar o contexto. O cleanup também libera a barreira em caso de erro, usa limites de tempo e registra erros adicionais sem substituir o primeiro erro. A observação da requisição retida também tem limite de tempo. A sequência de login, reload, troca de sessão, filtro e chave SWR no mesmo documento, verificações de RLS e operação posterior permanece no cenário; a resposta da rede não é simulada.

Checks desta alteração:

- `node --check e2e/frontend-v0-session-cross-tab.mjs`: **NOT RUN**, exit 127 (`node: command not found` nesta sessão; Node 22 disponível no host/runner).
- `git diff --check`: **PASS**, exit 0.
- Reexecução do navegador: **NOT RUN** nesta tarefa; a gerência executará o cenário dirigido no ambiente integrado já preparado. A regressão antes/depois não foi executada aqui.

A revisão independente permanece a próxima fase do controlador.
