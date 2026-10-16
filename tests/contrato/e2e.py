#!/usr/bin/env python3
"""Fumaça original do painel pelo Caddy, com API e seed exclusivamente Go."""
from pathlib import Path
import subprocess
import time

from lib import ROOT,LOCAL,command,sql,go_env,request
from lib import go, wait


def main():
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    go('build','-o','bin/api','./cmd/api')
    sql('drop database if exists nexo_test with (force);create database nexo_test;','postgres')
    env=go_env('nexo_test');env.update(NEXO_DEMO_MODE='1',NEXO_REQUIRE_ADMIN_MFA='0',NEXO_GO_ADDR='127.0.0.1:18181',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19181',NEXO_GO_AGENT_ADDR='127.0.0.1:18544',NEXO_GO_JOBS='0')
    for cmd in ['prepare','seed-demo']:command([str(ROOT/'apps/api-go/bin/nexo-db'),cmd],cwd=ROOT,env=env)
    command(['docker','build','--network','host','-f','infra/prod/caddy/Dockerfile','-t','nexo-fase1-caddy-web:local','.'],cwd=ROOT)
    command(['docker','create','--name','nexo-fase1-web-build','nexo-fase1-caddy-web:local'],capture_output=True)
    try:
        web=LOCAL/'e2e-web';web.mkdir(parents=True,exist_ok=True)
        command(['docker','cp','nexo-fase1-web-build:/srv/.',str(web)])
    finally:subprocess.run(['docker','rm','nexo-fase1-web-build'],capture_output=True)
    command(['npm','ci'],cwd=ROOT/'e2e')
    log=open(LOCAL/'e2e-go.log','w')
    api=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
    try:
        wait('http://127.0.0.1:18181','/api/health',api)
        command(['docker','run','-d','--name','nexo-fase1-caddy-e2e','--network','host',
                 '-v',str(ROOT/'infra/prod/caddy/Caddyfile')+':/etc/caddy/Caddyfile:ro','-v',str(web)+':/srv:ro',
                 '-e','NEXO_DOMAIN=http://127.0.0.1:18380','-e','NEXO_GO_UPSTREAM=127.0.0.1:18181',
                 'caddy:2-alpine','caddy','run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],capture_output=True)
        wait('http://127.0.0.1:18380','/api/health')
        keys=['x-content-type-options','x-frame-options','referrer-policy','permissions-policy','content-security-policy','strict-transport-security']
        for path in ['/','/login']:
            r=request('http://127.0.0.1:18380',path)
            assert r['status']==200 and r['body']==(web/'index.html').read_bytes()
            assert r['headers']['x-content-type-options']=='nosniff' and r['headers']['x-frame-options']=='DENY'
            assert "frame-ancestors 'none'" in r['headers']['content-security-policy']
        command(['docker','run','--rm','--network','host','--ipc=host','--security-opt','seccomp=unconfined',
                 '-v',str(ROOT/'e2e')+':/e2e','-w','/e2e','-e','BASE=http://127.0.0.1:18380',
                 'mcr.microsoft.com/playwright:v1.49.1-jammy','node','smoke.mjs'])
    finally:
        api.terminate()
        try:api.wait(timeout=15)
        except subprocess.TimeoutExpired:api.kill();api.wait()
        log.close()
        subprocess.run(['docker','rm','-f','nexo-fase1-caddy-e2e'],capture_output=True)

if __name__=='__main__':main()
