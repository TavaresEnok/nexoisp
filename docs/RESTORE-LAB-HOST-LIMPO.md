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
