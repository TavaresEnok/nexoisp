"""Volta o banco local do agente para a cópia feita antes de uma atualização de schema (ADR-009).

Uso, com o agente PARADO:  python -m nexo_agent.rollback <schema_alvo> [--force]
  <schema_alvo> = versão do schema local do binário para o qual se está voltando (campo local_schema do manifesto).

Não é automático de propósito: tudo o que o agente registrou DEPOIS da atualização deixa de existir no banco restaurado.
Se houver tentativa interrompida ou resultado ainda não entregue à nuvem, o comando recusa (a menos de --force), porque
perder esse registro tira do agente a capacidade de consultar antes de repetir. O banco atual é preservado ao lado.
"""
import os
import shutil
import sqlite3
import sys
import time

from .store import backup_path


def pending(path: str) -> dict:
    db = sqlite3.connect(path)
    try:
        one = lambda sql: db.execute(sql).fetchone()[0]
        return {"interrompidas": one("select count(*) from attempts where status in ('EXECUTING','VERIFYING')"),
                "resultados_nao_entregues": one("select count(*) from attempts where status = 'DONE' and outcome is not null and reported = 0")}
    finally:
        db.close()


def rollback(path: str, target: int, force: bool = False) -> str:
    bak = backup_path(path, target)
    if not os.path.exists(bak):
        raise SystemExit(f"não há cópia do schema {target} em {bak}; restaure o backup manual do diretório de dados")
    p = pending(path)
    if any(p.values()) and not force:
        raise SystemExit(f"há trabalho não concluído no banco atual ({p}); suba a versão nova para concluir/entregar ou use --force ciente da perda")
    kept = f"{path}.replaced-{time.strftime('%Y%m%d-%H%M%S')}"
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            shutil.move(path + suffix, kept + suffix)
    shutil.copy2(bak, path)
    return kept


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--force"]
    if len(args) != 1 or not args[0].isdigit():
        raise SystemExit(__doc__)
    data = os.environ.get("NEXO_AGENT_DATA", "/data")
    db = os.path.join(data, "agent.sqlite")
    print(f"banco restaurado para o schema {args[0]}; o banco substituído ficou em {rollback(db, int(args[0]), '--force' in sys.argv)}")
