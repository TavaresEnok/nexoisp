#!/usr/bin/env python3
"""Prova as duas adoções num cluster de laboratório; recusa qualquer outro nome."""
import hashlib
import json
import subprocess
from datetime import datetime, timezone

from lib import ROOT, DB_CONTAINER, DB_PORT, sql, command, go_env
from laboratorio import go, node


def main():
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    binary=str(ROOT/'apps/api-go/bin/nexo-db')
    report={}
    for database in ('nexo_contrato_novo','nexo_contrato_legado'):
        sql(f'drop database if exists {database} with (force); create database {database};', 'postgres')
        env=go_env(database)
        command([binary,'bootstrap','--init-app-role'],cwd=ROOT,env=env)
        if database.endswith('legado'):
            node("import {migrate} from './apps/api/src/migrate.ts'; await migrate(()=>{});",database)
            command([binary,'baseline'],cwd=ROOT,env=env)
            # Baseline é deliberadamente uma operação de adoção única.
            again=subprocess.run([binary,'baseline'],cwd=ROOT,env=env,capture_output=True,text=True)
            assert again.returncode!=0 and 'já existe' in again.stderr
        command([binary,'up'],cwd=ROOT,env=env)
        result=node("import {migrate} from './apps/api/src/migrate.ts'; const applied=[]; await migrate(x=>applied.push(x)); console.log(JSON.stringify(applied));",database,capture=True)
        assert json.loads(result.stdout.strip())==[], 'Fastify reaplicou migration'
        command([binary,'verificar'],cwd=ROOT,env=env)
        dump=command(['docker','exec',DB_CONTAINER,'pg_dump','-p',str(DB_PORT),'-U','nexo_owner','-d',database,
                      '--schema-only','--exclude-table=public.goose_db_version','--exclude-table=public.schema_migrations'],capture_output=True).stdout
        canonical='\n'.join(line for line in dump.splitlines() if not line.startswith(('\\restrict ','\\unrestrict ')))+'\n'
        report[database]={'fastify_pendentes':0,'schema_sha256':hashlib.sha256(canonical.encode()).hexdigest()}
        report[database]['_schema']=canonical
    a,b=[report[k].pop('_schema') for k in report]
    if a!=b:
        import difflib
        raise AssertionError('Esquemas divergentes:\n'+''.join(difflib.unified_diff(a.splitlines(True),b.splitlines(True))))
    # Banco parcial não pode receber baseline.
    sql('drop database if exists nexo_contrato_parcial with (force); create database nexo_contrato_parcial;', 'postgres')
    sql("create table schema_migrations(name text primary key); insert into schema_migrations values ('001_identidade_cadastro.sql');",'nexo_contrato_parcial')
    partial=subprocess.run([binary,'baseline'],cwd=ROOT,env=go_env('nexo_contrato_parcial'),capture_output=True,text=True)
    assert partial.returncode!=0 and 'incompleto' in partial.stderr
    report['convergencia']=True;report['baseline_parcial_recusado']=True
    path=ROOT/'tests/contrato/relatorios'/('migrations-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    path.parent.mkdir(exist_ok=True,parents=True);path.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))


if __name__=='__main__':main()
