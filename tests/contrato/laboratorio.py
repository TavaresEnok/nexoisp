#!/usr/bin/env python3
"""Sobe só recursos nexo-fase1, sem ler credenciais ou compose do produto."""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import tempfile
from pathlib import Path

from lib import ROOT, LOCAL, DB_CONTAINER, DB_PORT, DB_NAME, command, go_env, sql, request


def go(*args, **kwargs):
    env=dict(kwargs.pop('env',os.environ))
    if args and args[0]=='build':env['CGO_ENABLED']='0'
    kwargs['env']=env
    executable = os.getenv('NEXO_GO_BIN') or shutil.which('go')
    if executable:
        return command([executable, *args], cwd=ROOT/'apps/api-go', **kwargs)
    cache = LOCAL/'go-cache'; cache.mkdir(exist_ok=True, parents=True)
    image='nexo-fase1-go-tools:local'
    if subprocess.run(['docker','image','inspect',image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
        with tempfile.TemporaryDirectory(prefix='nexo-go-tools-') as temp:
            shutil.copyfile(ROOT/'tests/contrato/Dockerfile.tools',Path(temp)/'Dockerfile')
            command(['docker','build','--network','host','-t',image,temp])
    return command(['docker','run','--rm','--network','host','--security-opt','seccomp=unconfined',
                    '-v',str(ROOT)+':/app','-v',str(cache)+':/go','-w','/app/apps/api-go',
                    '-e','DATABASE_URL_OWNER','-e','NEXO_GO_DB_PASSWORD','-e','NEXO_APP_DB_PASSWORD',
                    '-e','NEXO_GO_TEST_DATABASE_URL','-e','CGO_ENABLED',image,'go',*args], **kwargs)


def node(script, database=DB_NAME, capture=False):
    env = go_env(database)
    # Chaves aleatórias usadas só para inicialização dos módulos do produto.
    args=['docker','run','--rm','--network','host','--security-opt','seccomp=unconfined',
          '-v',str(ROOT)+':/app','-w','/app']
    for k in ('DATABASE_URL_APP','DATABASE_URL_OWNER','NEXO_APP_DB_PASSWORD','NEXO_AGENT_MTLS'):
        args += ['-e',k]
    args += ['node:22-alpine','node','--import','tsx','--input-type=module','-e',script]
    return command(args, env=env, capture_output=capture)


def stop_go():
    path=LOCAL/'go.pid'
    if path.exists():
        pid=int(path.read_text())
        try:
            # Nunca sinaliza um PID reutilizado por outro programa.
            args=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            if str(ROOT/'apps/api-go/bin/api').encode() in args:
                os.kill(pid,signal.SIGTERM)
                for _ in range(100):
                    try: os.kill(pid,0)
                    except ProcessLookupError: break
                    time.sleep(.05)
        except (FileNotFoundError,ProcessLookupError): pass
        path.unlink()


def start_go(tags='', pool=10, rate=1200):
    stop_go();LOCAL.mkdir(exist_ok=True,parents=True)
    args=['build','-o','bin/api']
    if tags: args += ['-tags',tags]
    go(*args,'./cmd/api')
    env=dict(go_env(),NEXO_GO_DB_POOL=str(pool),NEXO_PANEL_RATE_PER_MIN=str(rate))
    log=open(LOCAL/'go.log','a')
    p=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    log.close();(LOCAL/'go.pid').write_text(str(p.pid))
    wait('http://127.0.0.1:19082','/healthz',p)


def wait(base,path,process=None):
    for _ in range(100):
        if process and process.poll() is not None:
            raise RuntimeError('processo encerrou; veja tests/contrato/local/go.log')
        try:
            if request(base,path)['status']==200: return
        except OSError: pass
        time.sleep(.1)
    raise RuntimeError('serviço não ficou pronto: '+base)


def up():
    LOCAL.mkdir(exist_ok=True,parents=True)
    state=command(['docker','inspect',DB_CONTAINER],capture_output=True) if subprocess.run(['docker','inspect',DB_CONTAINER],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 else None
    if not state:
        command(['docker','run','-d','--name',DB_CONTAINER,'--network','host','--cpus','4',
                 '-e','POSTGRES_USER=nexo_owner','-e','POSTGRES_PASSWORD=fase1-owner-local','-e','POSTGRES_DB='+DB_NAME,
                 'postgres:16-alpine','-p',str(DB_PORT),'-c','shared_preload_libraries=pg_stat_statements',
                 '-c','pg_stat_statements.track_planning=on','-c','max_connections=150','-c','listen_addresses=127.0.0.1'])
    else: command(['docker','start',DB_CONTAINER],stdout=subprocess.DEVNULL)
    for _ in range(100):
        try: sql('select 1');break
        except subprocess.CalledProcessError:time.sleep(.1)
    go('build','-o','bin/nexo-db','./cmd/nexo-db')
    env=go_env()
    for args in (['bootstrap','--init-app-role'],['up'],['verificar']):
        command([str(ROOT/'apps/api-go/bin/nexo-db'),*args],cwd=ROOT,env=env)
    if sql("select count(*) from tenants where slug like 'bench-%'")=='0':
        seed=(ROOT/'tests/contrato/dados/seed.sql').read_text()
        sql('\\set tenants 30\n\\set subscribers 3000\n\\set min_per_tenant 20\n'+seed)
    sql((ROOT/'tests/contrato/dados/controles.sql').read_text())
    subprocess.run(['docker','rm','-f','nexo-fase1-fastify'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    command(['docker','run','-d','--name','nexo-fase1-fastify','--network','host','--security-opt','seccomp=unconfined',
             '-v',str(ROOT)+':/app','-w','/app','-e','DATABASE_URL_APP','-e','NEXO_AGENT_MTLS','-e','NEXO_REQUIRE_ADMIN_MFA',
             '-e','PORT=18081','node:22-alpine','node','--import','tsx','tests/contrato/fastify.mjs'],env=env)
    wait('http://127.0.0.1:18081','/api/health')
    start_go()
    print('Laboratório pronto: Fastify 127.0.0.1:18081; Go 127.0.0.1:18082; interno 127.0.0.1:19082')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['up','down','run','mutacoes','migrations','carga','leituras','proxy','consultas','grupos','escopo_pop','regressoes','e2e','aviso','dinamicas']);args,rest=parser.parse_known_args()
    if args.command=='up':up()
    elif args.command=='down':
        stop_go();subprocess.run(['docker','rm','-f','nexo-fase1-fastify',DB_CONTAINER],check=True)
    elif args.command=='run':
        go('test','-race','./...',env=dict(go_env(),NEXO_GO_TEST_DATABASE_URL=go_env()['DATABASE_URL_GO']))
        command([sys.executable,str(ROOT/'tests/contrato/contrato.py'),*rest])
        command([sys.executable,str(ROOT/'tests/contrato/cache.py')])
    else:command([sys.executable,str(ROOT/f'tests/contrato/{args.command}.py'),*rest])


if __name__=='__main__':main()
