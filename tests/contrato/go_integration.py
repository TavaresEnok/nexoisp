#!/usr/bin/env python3
"""Run PostgreSQL-dependent Go tests with a freshly prepared disposable DB."""
import base64
import os
import subprocess
import uuid

# Separate from other contract tests and never reuse an existing container.
os.environ['NEXO_CONTRATO_DB_CONTAINER'] = 'nexo-go-tests-' + uuid.uuid4().hex[:10]
os.environ['NEXO_CONTRATO_DB_PORT'] = '15689'
from lib import ROOT, DB_CONTAINER, command, go, go_env, sql
from nativo import up


def main():
    try:
        up()
        sql('create database nexo_test', 'postgres')
        env = dict(go_env('nexo_test'), NEXO_DEMO_MODE='1',
                   NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode())
        go('build', '-o', 'bin/nexo-db', './cmd/nexo-db')
        for task in ['prepare', 'seed-demo']:
            command([str(ROOT/'apps/api-go/bin/nexo-db'), task], cwd=ROOT, env=env)
        sql("insert into pops(tenant_id,name) select id,'POP sintético A' from tenants;"
            "insert into pops(tenant_id,name) select id,'POP sintético B' from tenants;"
            "update contracts c set pop_id=(select id from pops p where p.tenant_id=c.tenant_id order by p.id limit 1)",
            'nexo_test')
        # Packages share a seeded disposable tenant. Jobs deliberately installs an
        # invalid tenant timezone; serialize packages so that fault injection cannot
        # contaminate finance receipts. Goroutine/race concurrency inside each test
        # remains enabled, including multi-worker receipt/idempotency tests.
        go('test', '-count=1', '-race', '-p', '1', '-json', './...',
           env=dict(env, NEXO_GO_TEST_DATABASE_URL=env['DATABASE_URL_GO']))
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', DB_CONTAINER], capture_output=True)


if __name__ == '__main__':
    main()
