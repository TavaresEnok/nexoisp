# Referência Fastify desativada

`fastify/` preserva a implementação anterior, seus testes e as 53 migrations originais para comparação e retorno controlado. Não pertence aos workspaces ativos, não é incluída nas imagens Go e não é iniciada pelos comandos padrão.

API, rotinas, VPN, instalação e administração usam `apps/api-go`. Node permanece no build do frontend React e nas ferramentas opcionais de comparação do legado. Não apague este acervo enquanto houver necessidade de rollback ou de reproduzir contratos históricos.

Para preparar somente as ferramentas legadas: `npm ci --prefix legacy/fastify --workspaces=false`. Os ensaios antigos que importam funções Node diretamente continuam sendo comparações de referência; os requests dos ensaios `regressoes` e `e2e` são atendidos pelo Go.
