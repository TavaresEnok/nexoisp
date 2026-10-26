#!/usr/bin/env python3
"""Capture dump + manifest in one PostgreSQL snapshot; verify restored contents."""
import argparse
import json
import os
from pathlib import Path
import subprocess

CATALOG = """select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relforcerowsecurity) order by c.relname)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 'policies',(select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='public'),
 'grants',(select jsonb_agg(jsonb_build_array(table_name,grantee,privilege_type) order by table_name,grantee,privilege_type)
 from information_schema.role_table_grants where table_schema='public' and grantee in ('nexo_go','nexo_app','nexo_radius')),
 'versions',(select jsonb_agg(jsonb_build_array(version_id,is_applied) order by id) from goose_db_version)
)::text;"""

class Session:
    def __init__(self, container, database):
        self.proc = subprocess.Popen(['docker','exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','nexo_owner','-p',os.environ.get('NEXO_DB_PORT','5432'),'-d',database],
                                     stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
    def query(self, sql):
        self.proc.stdin.write(sql+'\n'); self.proc.stdin.flush()
        row = self.proc.stdout.readline()
        if not row:
            raise RuntimeError('consulta de verificação falhou')
        return json.loads(row)
    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.write('rollback;\n'); self.proc.stdin.close()
            except BrokenPipeError:
                pass
        if self.proc.wait() != 0:
            raise RuntimeError('sessão de verificação falhou')

def manifest(session):
    result = {'format': 1, 'catalog': session.query(CATALOG), 'counts': {}}
    for table, _, _ in result['catalog']['tables'] or []:
        result['counts'][table] = session.query('select count(*) from public."'+table.replace('"','""')+'";')
    result['finance'] = session.query("""select coalesce(jsonb_agg(to_jsonb(x) order by tenant_id,status),'[]')::text from
      (select tenant_id,status,count(*) as invoices,sum(amount_cents)::text as cents from invoices group by tenant_id,status) x;""")
    result['payments'] = session.query("""select coalesce(jsonb_agg(to_jsonb(x) order by tenant_id,kind),'[]')::text from
      (select tenant_id,kind,count(*) as payments,sum(amount_cents)::text as cents from payments group by tenant_id,kind) x;""")
    return result

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['capture','verify'])
    parser.add_argument('file',type=Path)
    parser.add_argument('--database',default='nexo')
    args=parser.parse_args()
    container=os.environ.get('NEXO_DB_CONTAINER','nexoisp-db-1')
    session=Session(container,args.database)
    try:
        # The exporter remains open through pg_dump and all manifest queries.
        snapshot=session.query('begin isolation level repeatable read read only; select to_json(pg_export_snapshot());')
        if args.action=='capture':
            with args.file.open('wb') as target:
                subprocess.run(['docker','exec',container,'pg_dump','-U','nexo_owner','-p',os.environ.get('NEXO_DB_PORT','5432'),'-Fc','--snapshot='+snapshot,args.database],stdout=target,check=True)
            args.file.with_suffix(args.file.suffix+'.manifest.json').write_text(json.dumps(manifest(session),sort_keys=True)+'\n')
        else:
            expected=json.loads(args.file.with_suffix(args.file.suffix+'.manifest.json').read_text())
            actual=manifest(session)
            if actual!=expected:
                failed=[key for key in actual if actual[key]!=expected.get(key)]
                raise RuntimeError('restauração diverge do snapshot: '+', '.join(failed))
            print('snapshot conferido: tabelas, RLS, permissões, versões, contagens e totais financeiros')
    finally:
        session.close()

if __name__=='__main__':
    main()
