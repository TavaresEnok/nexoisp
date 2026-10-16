#!/usr/bin/env python3
"""Fumaça original do painel servido pelo Caddy, com banco e contas sintéticas."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import time

from lib import ROOT,LOCAL,command,sql,go_env,request
from laboratorio import go,node,wait


def main():
    spec=importlib.util.spec_from_file_location('proxy_generator',ROOT/'scripts/migracao-go/proxy.py');proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    sql('drop database if exists nexo_test with (force);create database nexo_test;','postgres')
    env=go_env('nexo_test');env.update(NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',PORT='18181')
    for cmd in ['bootstrap','up']:command([str(ROOT/'apps/api-go/bin/nexo-db'),cmd],cwd=ROOT,env=env)
    command(['docker','run','--rm','--network','host','--security-opt','seccomp=unconfined','-v',str(ROOT)+':/app','-w','/app',
             '-e','DATABASE_URL_APP','-e','NEXO_DEMO_MODE','-e','NEXO_AGENT_MTLS','node:22-alpine','node','--import','tsx','--input-type=module','-e',
             "import {seedDemo} from './apps/api/src/seed.ts';import {closePool} from './apps/api/src/db.ts';await seedDemo(()=>{});await closePool();"],env=env)
    command(['docker','build','--network','host','-f','infra/prod/caddy/Dockerfile','-t','nexo-fase1-caddy-web:local','.'],cwd=ROOT)
    command(['docker','create','--name','nexo-fase1-web-build','nexo-fase1-caddy-web:local'],capture_output=True)
    try:
        web=LOCAL/'e2e-web';web.mkdir(parents=True,exist_ok=True)
        command(['docker','cp','nexo-fase1-web-build:/srv/.',str(web)])
    finally:subprocess.run(['docker','rm','nexo-fase1-web-build'],capture_output=True)
    command(['npm','ci'],cwd=ROOT/'e2e')
    with tempfile.TemporaryDirectory(prefix='nexo-e2e-proxy-') as tmp:
        cfg=Path(tmp)/'Caddyfile';cfg.write_text('{\n admin 127.0.0.1:18390\n}\n'+proxy.generate(proxy.load()))
        try:
            command(['docker','run','-d','--name','nexo-fase1-e2e-fastify','--network','host','--security-opt','seccomp=unconfined',
                     '-v',str(ROOT)+':/app','-v',str(web)+':/app/apps/web/dist:ro','-w','/app','-e','DATABASE_URL_APP','-e','NEXO_DEMO_MODE','-e','NEXO_AGENT_MTLS','-e','NEXO_REQUIRE_ADMIN_MFA','-e','PORT',
                     'node:22-alpine','node','--import','tsx','tests/contrato/fastify.mjs'],env=env,capture_output=True)
            wait('http://127.0.0.1:18181','/api/health')
            command(['docker','run','-d','--name','nexo-fase1-caddy-e2e','--network','host','-v',tmp+':/cfg:ro','-v',str(web)+':/srv:ro',
                     '-e','NEXO_DOMAIN=http://127.0.0.1:18380','-e','NEXO_FASTIFY_UPSTREAM=127.0.0.1:18181',
                     'caddy:2-alpine','caddy','run','--config','/cfg/Caddyfile','--adapter','caddyfile'],capture_output=True)
            wait('http://127.0.0.1:18380','/api/health')
            keys=['x-content-type-options','x-frame-options','referrer-policy','permissions-policy','content-security-policy','strict-transport-security']
            for path in ['/','/login']:
                a,b=[request(base,path) for base in ['http://127.0.0.1:18181','http://127.0.0.1:18380']]
                assert a['status']==b['status']==200 and a['body']==b['body']
                for key in keys:assert a['headers'].get(key)==b['headers'].get(key),(path,key)
            command(['docker','run','--rm','--network','host','--ipc=host','--security-opt','seccomp=unconfined',
                     '-v',str(ROOT/'e2e')+':/e2e','-w','/e2e','-e','BASE=http://127.0.0.1:18380',
                     'mcr.microsoft.com/playwright:v1.49.1-jammy','node','smoke.mjs'])
        finally:
            for container in ['nexo-fase1-caddy-e2e','nexo-fase1-e2e-fastify']:subprocess.run(['docker','rm','-f',container],capture_output=True)

if __name__=='__main__':main()
