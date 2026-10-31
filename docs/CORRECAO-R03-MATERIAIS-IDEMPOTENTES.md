# R03 — intenção de lançamento de material

Na base indicada, `workMaterials` executava `stockMove` em cada POST, o schema aceitava apenas item e quantidade e a interface não preservava um identificador. Os únicos outros chamadores identificados foram o teste de contrato `sgp_auditoria.py` e o fluxo de interface `frontend-v0-field.mjs`; kits não usam essa rota.

O cliente grava UUID, item e quantidade no armazenamento local, com chave versionada por `sessionScope` e OS, antes de enviar. Enquanto o resultado for incerto, o formulário conserva o payload e só permite confirmar a mesma intenção; uma resposta 400 ou saldo insuficiente confirma a rejeição e libera correção. Após confirmação, uma nova operação recebe outro UUID. Erros de armazenamento impedem o primeiro envio.

A criação e a remoção usam Web Locks por namespace, pois a leitura e a escrita de localStorage não são atômicas entre abas. A confirmação só remove o UUID que recebeu resposta; se outra aba já gravou uma intenção posterior, ela permanece. Sem Web Locks a criação falha antes do envio. O teste dirigido reproduz criação concorrente e replay tardio após outra intenção ter sido persistida.

Na mesma transação, um bloqueio consultivo serializa o UUID, a OS é consultada sob RLS/POP e o recibo persistido é devolvido antes da verificação de encerramento. Novos movimentos mantêm as validações anteriores. A migração 85 adiciona tabela sem UPDATE/DELETE para o papel da aplicação, chaves por tenant, vínculo com o movimento e políticas RLS; uma função restrita detecta colisões invisíveis sem revelar seus dados. Evento, movimento e recibo são revertidos juntos em caso de erro.

Checks desta sessão:

```text
/usr/local/go/bin/go -C apps/api-go mod download
exit 0

TMPDIR=<worktree>/.r03-tmp /usr/local/go/bin/go -C apps/api-go test -race ./internal/modules/escrita -run '^TestR03' -count=1 -v
=== RUN   TestR03MaterialIntentRequired
--- PASS: TestR03MaterialIntentRequired (0.00s)
=== RUN   TestR03MaterialIntentPG
    material_intent_test.go:35: PostgreSQL ausente; SKIP não comprova SQL, concorrência ou RLS
--- SKIP: TestR03MaterialIntentPG (0.00s)
PASS
ok  nexoisp/api-go/internal/modules/escrita  1.065s
exit 0

node node_modules/tsx/dist/cli.mjs --test apps/web/tests/material-intent.test.ts
/bin/bash: line 1: node: command not found
exit 127
npm -w apps/web run typecheck
/usr/bin/env: ‘node’: No such file or directory
exit 127
node --check e2e/frontend-v0-material-intent.mjs
/bin/bash: line 1: node: command not found
exit 127
git diff --check
exit 0
```

O teste PostgreSQL exige laboratório descartável `nexo_test` com `nexo_go`, dados de referência e dois provedores. Sem `NEXO_GO_TEST_DATABASE_URL` ele registra SKIP; `PG_REQUIRED=1` transforma a ausência em falha. O cenário de browser usa backend real e descarta somente a resposta depois do commit, e não foi executado nesta sessão. A instalação de Node não estava disponível: os comandos do teste de persistência, typecheck e `node --check` retornaram 127 (`node: command not found`); requerem o runner autorizado. Essas ausências não comprovam SQL nem comportamento no browser.

Após correção da coordenação entre abas, os mesmos checks foram repetidos: `go mod download` exit 0; `go test -race ... -run '^TestR03' -count=1 -v` exit 0 com teste obrigatório PASS e PostgreSQL SKIP (sem URL); teste TypeScript, typecheck e `node --check` exit 127 (Node ausente); `git diff --check` exit 0. Browser e PostgreSQL reais permanecem NOTRUN e exigem runner/laboratório autorizado.
