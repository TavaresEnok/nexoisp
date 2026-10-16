#!/usr/bin/env python3
"""D1: regressões originais pelo Caddy real, num nexo_test isolado do produto."""
import importlib.util
import json
import os
import base64
import sys
from pathlib import Path
import subprocess
import tempfile
import time

from lib import ROOT,LOCAL,command,sql,go_env,request
from laboratorio import go,wait


def main():
    spec=importlib.util.spec_from_file_location('proxy_generator',ROOT/'scripts/migracao-go/proxy.py');proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    go('build','-tags','contractbridge','-o','bin/api-regressoes','./cmd/api')
    sql('drop database if exists nexo_test with (force);create database nexo_test;','postgres')
    env=go_env('nexo_test');env.update(NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',NEXO_TEST_BASE_URL='http://127.0.0.1:18280',NEXO_TEST_BACKEND='go',NEXO_TEST_AGENT_URL='http://127.0.0.1:18545',NEXO_GO_ADDR='127.0.0.1:18181',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19181',NEXO_GO_AGENT_ADDR='127.0.0.1:18545',NEXO_GO_JOBS='0',NEXO_TEST_RELAY_KEY=base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('='),NEXO_SECRET_KEY=base64.b64encode(os.urandom(32)).decode(),NEXO_OP_SIGNING_KEY=base64.b64encode(subprocess.check_output(['openssl','genpkey','-algorithm','ed25519','-outform','DER'])).decode())
    for cmd in ['prepare','seed-demo']:
        command([str(ROOT/'apps/api-go/bin/nexo-db'),cmd],cwd=ROOT,env=env)
    with tempfile.TemporaryDirectory(prefix='nexo-regression-proxy-') as tmp:
        cfg=Path(tmp)/'Caddyfile';cfg.write_text('{\n admin 127.0.0.1:18290\n}\n'+proxy.generate(proxy.load(ROOT/'infra/prod/caddy/rotas.go.yaml'),fallback='go'))
        log=open(LOCAL/'regressoes-go.log','w')
        api=subprocess.Popen([str(ROOT/'apps/api-go/bin/api-regressoes')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        wait('http://127.0.0.1:19181','/healthz',api)
        command(['docker','run','-d','--name','nexo-fase1-caddy-regressao','--network','host','-v',tmp+':/cfg:ro',
                 '-e','NEXO_DOMAIN=http://127.0.0.1:18280','-e','NEXO_GO_UPSTREAM=127.0.0.1:18181',
                 'caddy:2-alpine','caddy','run','--config','/cfg/Caddyfile','--adapter','caddyfile'],capture_output=True)
        try:
            args=['docker','run','--rm','--network','host','--security-opt','seccomp=unconfined','-v',str(ROOT)+':/app','-w','/app']
            for name in ['DATABASE_URL_OWNER','DATABASE_URL_APP','NEXO_APP_DB_PASSWORD','NEXO_AGENT_MTLS','NEXO_DEMO_MODE','NEXO_REQUIRE_ADMIN_MFA','NEXO_TEST_BASE_URL','NEXO_TEST_AGENT_URL','NEXO_TEST_BACKEND','NEXO_TEST_RELAY_KEY','NEXO_SECRET_KEY','NEXO_OP_SIGNING_KEY']:args+=['-e',name]
            args+=['node:22-alpine','npm','--prefix','legacy/fastify','--workspaces=false','test']
            if sys.argv[1:]:args+=['--',*sys.argv[1:]]
            command(args,env=env)
        finally:
            subprocess.run(['docker','rm','-f','nexo-fase1-caddy-regressao'],capture_output=True)
            api.terminate()
            try:api.wait(timeout=15)
            except subprocess.TimeoutExpired:api.kill();api.wait()
            log.close()

if __name__=='__main__':main()
