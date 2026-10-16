#!/usr/bin/env python3
"""D1: regressões originais pelo Caddy real, num nexo_test isolado do produto."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from lib import ROOT,command,sql,go_env,request
from laboratorio import go


def main():
    spec=importlib.util.spec_from_file_location('proxy_generator',ROOT/'scripts/migracao-go/proxy.py');proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    sql('drop database if exists nexo_test with (force);create database nexo_test;','postgres')
    env=go_env('nexo_test');env.update(NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',NEXO_TEST_BASE_URL='http://127.0.0.1:18280',NEXO_TEST_UPSTREAM_PORT='18181')
    for cmd in ['bootstrap','up']:
        command([str(ROOT/'apps/api-go/bin/nexo-db'),cmd],cwd=ROOT,env=env)
    with tempfile.TemporaryDirectory(prefix='nexo-regression-proxy-') as tmp:
        cfg=Path(tmp)/'Caddyfile';cfg.write_text('{\n admin 127.0.0.1:18290\n}\n'+proxy.generate(proxy.load()))
        command(['docker','run','-d','--name','nexo-fase1-caddy-regressao','--network','host','-v',tmp+':/cfg:ro',
                 '-e','NEXO_DOMAIN=http://127.0.0.1:18280','-e','NEXO_FASTIFY_UPSTREAM=127.0.0.1:18181',
                 'caddy:2-alpine','caddy','run','--config','/cfg/Caddyfile','--adapter','caddyfile'],capture_output=True)
        try:
            args=['docker','run','--rm','--network','host','--security-opt','seccomp=unconfined','-v',str(ROOT)+':/app','-w','/app']
            for name in ['DATABASE_URL_OWNER','DATABASE_URL_APP','NEXO_APP_DB_PASSWORD','NEXO_AGENT_MTLS','NEXO_DEMO_MODE','NEXO_REQUIRE_ADMIN_MFA','NEXO_TEST_BASE_URL','NEXO_TEST_UPSTREAM_PORT']:args+=['-e',name]
            args+=['node:22-alpine','npm','-w','apps/api','test']
            command(args,env=env)
        finally:subprocess.run(['docker','rm','-f','nexo-fase1-caddy-regressao'],capture_output=True)

if __name__=='__main__':main()
