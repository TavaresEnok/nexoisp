# Ensaio B12 — restore em cluster vazio de laboratório

O comando abaixo cria dois PostgreSQL descartáveis, gera um backup sintético na origem e restaura esse backup num cluster novo. Não lê `.env`, não usa `nexoisp-db-1` nem `nexoisp-prod` e não reaproveita volume, banco ou senha de papel da origem.

```bash
python3 tests/contrato/restore_clean_host.py
```

O processo termina com erro se Docker, Go, OpenSSL ou a imagem `postgres:16-alpine` não estiverem disponíveis. Não há skip. `python3 -m unittest discover -s tests/operacao -p test_restore_clean_host.py` só cobre as recusas de identidade e de artefato. Esse teste estático não aprova B12.

## O que a corrida faz

1. Sobe dois containers e dois volumes com nomes `nexo-b12-src-<execução>` e `nexo-b12-dst-<execução>`, rótulo `nexo.lab=b12-clean-host` e `nexo.lab.run=<execução>`. As portas são publicadas só em `127.0.0.1`. Se o nome já existe, a corrida para antes de apagar ou reutilizar o recurso.
2. Na origem, `nexo-db prepare` e `seed-demo` criam o schema e a massa `*.demo`. O harness acrescenta documento PDF, segredo AES (MFA), segredo RADIUS, fila `notice_log` em `queued`, um job River `available`, dois POPs e uma compensação de lote já committed. `NEXO_GO_JOBS=0`. Não há transporte externo.
3. `scripts/backup-manifest.py capture` grava o dump e o manifesto no mesmo snapshot. A soma SHA-256 cobre os dois arquivos, no formato de `scripts/backup.sh`.
4. No destino, `nexo-db bootstrap --init-app-role` cria `nexo_app`, `nexo_go`, `nexo_radius` e `nexo_replica` com senhas novas. O owner do container é o superusuário de laboratório. `nexo_go` e `nexo_app` ficam sem superuser, sem bypassrls e sem ownership das tabelas. O banco restaurado chama-se `nexo_restore_check_<pid>_<n>`, que é o contrato de `verify-restore`.
5. `pg_restore --no-owner --exit-on-error` carrega o dump. Em seguida correm `backup-manifest.py verify`, `scripts/restore-isolation.sql` e `nexo-db verify-restore` com a chave AES e a chave RADIUS entregues no ambiente do processo, não lidas de arquivo.
6. A API sobe no destino com jobs desligados. O ensaio confere login, bytes e SHA-256 do documento, download autorizado, recusa do outro tenant e do portal, e o contrato do outro POP. A fila continua `queued` / `available` depois de reiniciar a API. O POST da mesma compensação devolve o mesmo marcador, com `idempotent_replay=true`, sem nova reversão.
7. Manifesto alterado sem soma válida é recusado antes do `pg_restore`. Dump alterado, mesmo com soma recalculada, não é registrado como restore bem-sucedido.

A saída JSON impressa no stdout e o arquivo `tests/contrato/relatorios/restore-clean-host.json` incluem `base` (o `git rev-parse HEAD`), as fases verificadas e os limites. Não incluem senha, chave, documento nem segredo.

## Corrida registrada em 0086558

Em 2026-10-29 a gerência executou `python3 tests/contrato/restore_clean_host.py` na base `0086558d9296054cfaf89071c9ae1bf0f2f56571`. O processo terminou exit 0. A cópia arquivada desta corrida está fora do clone:

- `/home/enok/Documentos/projetos/implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/restore-clean-host-0086558.json`
- `/home/enok/Documentos/projetos/implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/gate-summary-0086558.json`
- `gate-restore-clean-host-0086558.log`, no mesmo diretório

`ok` é verdadeiro. `criterion` é B12. `static_approval` é falso. `published` no resumo do gate é falso. Os 13 testes de `tests/operacao/test_restore_clean_host.py` continuam sendo só a recusa estática. O run hospedado do passo em `.github/workflows/native.yml` não foi conferido.

O log lista 17 fases, nesta ordem: identidade; origem sintética; backup manifesto e soma; bootstrap do destino; manipulação recusada; restore no cluster vazio; manifesto conferido; isolamento e grants; documentos por bytes; verify-restore; chave errada recusada; fila persistida sem execução; login e sessão; download HTTP e recusa entre tenants; portal e POP; retomada com jobs desligados; replay da compensação B13.

O que essa corrida comprovou:

- Dois clusters sintéticos novos, com recursos próprios da execução `30cf94629328`. Origem: container `nexo-b12-src-30cf94629328`, volume `nexo-b12-src-vol-30cf94629328`, porta 33639. Destino: container `nexo-b12-dst-30cf94629328`, volume `nexo-b12-dst-vol-30cf94629328`, porta 37163. Imagem `postgres:16-alpine`. Rótulo `nexo.lab=b12-clean-host`. O harness registrou a limpeza desses recursos.
- Recusa de manipulação: `checksum-manifesto` e `dump-manipulado`. A fase seguinte recusou chave errada.
- Documentos conferidos por bytes, pela verificação do restore e pelo download HTTP, com recusa entre tenants.
- Isolamento e grants, inclusive o papel não privilegiado do ensaio, e as fases de portal e POP.
- Login e sessão.
- Fila persistida sem execução e retomada com jobs desligados.
- Replay da compensação B13 na fase final, sem nova reversão. Segredos ficaram omitidos.

O que permanece aberto depois do exit 0: host físico, cópia externa e `NEXO_BACKUP_COPY`, cofre, RPO e RTO produtivo, a suíte do repositório Backup-center, o piloto e exactly-once externo. O destino vazio simulado não substitui cluster físico nem cofre. A causa desta corrida não é falta de autorização nem de bancada: o ensaio sintético já foi executado. Repeti-lo só para obter de novo o mesmo exit 0 não é o próximo trabalho. Host físico, cópia externa, cofre, medida produtiva, Backup-center, piloto e exactly-once externo continuam cada um com a própria prova.

## Recursos e limpeza

A limpeza do próprio processo só remove container e volume cujo rótulo `nexo.lab.run` é o desta execução. O diretório temporário do dump usa o mesmo identificador e é apagado ao final.

Se a corrida for interrompida:

```bash
docker ps -aq --filter label=nexo.lab=b12-clean-host
docker volume ls -q --filter label=nexo.lab=b12-clean-host
```

Confira o `nexo.lab.run` antes de remover. Não apague `nexoisp-db-1`, `nexo-fase1-db` nem `nexo-resilience-db` por causa deste ensaio. No workflow nativo, o passo final também remove o que ainda tiver o rótulo `nexo.lab=b12-clean-host`, além dos containers de laboratório que ele já removia.

## Limites

Este ensaio não homologa host físico, cópia externa, cofre, RPO/RTO produtivo, integração com Backup-center nem o piloto. A fila que permanece `queued` com jobs desligados prova persistência e retomada sem transporte; não prova exactly-once fora do laboratório. Os nomes `nexo_app` e `nexo_go` existem nos dois clusters porque o schema concede privilégios a esses papéis. As senhas e os volumes são outros.
