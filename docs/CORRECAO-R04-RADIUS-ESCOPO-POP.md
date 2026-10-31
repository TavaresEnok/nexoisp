# R04 — status RADIUS e escopo POP

Confirmação: `/api/radius/status` consultava `vpn_settings` em escopo de instalação antes de consultar as capacidades; estas agregam contas, NAS, sessões e eventos por tenant. A flag `accounting_review_allowed` não removia as contagens da resposta.

A rota recusa com 403 qualquer `Scope.PopIDs` não nulo, inclusive lista vazia, antes de abrir a transação de instalação. A mesma verificação protege os dois métodos que fazem as consultas. A autenticação, a permissão `network:read`, o tenant obrigatório e o formato da resposta para escopo completo continuam sob as regras existentes.

O teste HTTP usa o registrador e middleware reais, com banco nulo para demonstrar que a recusa precede a abertura da transação. Também cobre portal, operador sem tenant e suporte restrito. O teste PostgreSQL usa apenas `nexo_test`/`nexo_go`, exige dois tenants existentes e cria dados sintéticos; cobre dois POPs no primeiro tenant, um segundo tenant, POP parcial/vazio e contagens de contas, NAS, sessões abertas e quarentena. Os POPs ficam em uma transação revertida: a recusa da rota não precisa consultá-los, e o papel restrito não possui DELETE nessa tabela. As contas, NAS e dispositivos são confirmados para visibilidade na rota e removidos por comandos permitidos ao papel, com erros de limpeza reportados. `PG_REQUIRED=1` transforma ausência de URL em falha.

Validação nesta sessão:

- `go -C apps/api-go mod download`: exit 0, Go 1.27.3 em `/usr/local/go/bin` adicionado ao PATH.
- `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR04' -count=1 -v`: exit 0 com `GOTMPDIR` na worktree. Teste HTTP passou; teste PostgreSQL teve SKIP explícito por ausência de `NEXO_GO_TEST_DATABASE_URL`.
- `git diff --check`: exit 0.

O SKIP não comprova SQL, RLS, isolamento entre tenants ou a fixture física. A gerência deve executar o teste dirigido com `PG_REQUIRED=1` no `nexo_test` descartável após integração.
