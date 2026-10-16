#!/usr/bin/env python3
"""Caddy real: peso por rota/método, rota irmã, estáticos e volta sem reiniciar API."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from lib import ROOT,command,request

spec=importlib.util.spec_from_file_location('proxy_generator',ROOT/'scripts/migracao-go/proxy.py')
proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)


class Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        body=json.dumps({'upstream':self.server.label,'path':self.path,'method':self.command}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
        if self.command!='HEAD':self.wfile.write(body)
    do_POST=do_GET
    do_HEAD=do_GET
    def log_message(self,*args):pass


def main():
    routes=proxy.load();report={};servers=[]
    try:
        for port,label in [(18191,'fastify'),(18192,'go')]:
            server=ThreadingHTTPServer(('127.0.0.1',port),Upstream);server.label=label;servers.append(server)
            threading.Thread(target=server.serve_forever,daemon=True).start()
        with tempfile.TemporaryDirectory(prefix='nexo-caddy-test-') as tmp:
            folder=Path(tmp);(folder/'index.html').write_text('<!doctype html><title>NexoISP</title>');(folder/'asset.js').write_text('window.nexo=true;')
            cfg=folder/'Caddyfile'
            def write(state,percent=None):
                for r in routes:
                    if (r['method'],r['path'])==('GET','/api/contracts/:id'):r['state']=state;r['percent']=percent
                cfg.write_text('{\n admin 127.0.0.1:18190\n}\n'+proxy.generate(routes))
            write('fastify')
            command(['docker','run','-d','--name','nexo-fase1-caddy-test','--network','host','-v',tmp+':/cfg:ro',
                     '-e','NEXO_DOMAIN=http://127.0.0.1:18180','-e','NEXO_WEB_ROOT=/cfg','-e','NEXO_FASTIFY_UPSTREAM=127.0.0.1:18191','-e','NEXO_GO_UPSTREAM=127.0.0.1:18192',
                     'caddy:2-alpine','caddy','run','--config','/cfg/Caddyfile','--adapter','caddyfile'],capture_output=True)
            for _ in range(100):
                try:
                    if request('http://127.0.0.1:18180','/api/health')['status']==200:break
                except OSError:pass
                time.sleep(.1)
            for state,percent in [('fastify',None),('go-canario',1),('go-canario',10),('go-canario',50),('go',None),('fastify',None)]:
                write(state,percent)
                command(['docker','exec','nexo-fase1-caddy-test','caddy','reload','--address','127.0.0.1:18190','--config','/cfg/Caddyfile','--adapter','caddyfile'],capture_output=True)
                counts={'go':0,'fastify':0}
                for i in range(100):counts[request('http://127.0.0.1:18180','/api/contracts/fixture')['json']['upstream']]+=1
                wanted=percent if state=='go-canario' else 100 if state=='go' else 0
                assert counts=={'go':wanted,'fastify':100-wanted},(state,counts)
                report[state+str(percent)]=counts
                # Mesmo padrão de caminho não muda métodos de escrita ou rota filha.
                for path,method in [('/api/contracts/fixture','POST'),('/api/contracts/fixture/history','GET'),('/public/v1/subscribers','GET'),('/aviso/demo','GET')]:
                    assert request('http://127.0.0.1:18180',path,method=method)['json']['upstream']=='fastify'
            static=request('http://127.0.0.1:18180','/panel/deep/link')
            assert static['body']==(folder/'index.html').read_bytes()
            h=static['headers'];assert h['x-content-type-options']=='nosniff' and h['x-frame-options']=='DENY' and "frame-ancestors 'none'" in h['content-security-policy']
            assert 'content-security-policy' not in request('http://127.0.0.1:18180','/asset.js')['headers']
            captured=command(['docker','logs','nexo-fase1-caddy-test'],capture_output=True)
            logs=captured.stdout+'\n'+captured.stderr
            access=[json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            (ROOT/'tests/contrato/local/caddy-test-log.json').write_text(json.dumps(access,indent=2))
            assert any(r.get('nexo_route')=='GET /api/contracts/:id' and r.get('nexo_upstream')=='tcp/127.0.0.1:18192' for r in access)
            report.update({'isolamento_metodo_e_caminho':True,'static_spa_headers':True,'logs_rota_destino':True,'rollback_sem_reiniciar_api':True})
    finally:
        subprocess.run(['docker','rm','-f','nexo-fase1-caddy-test'],capture_output=True)
        for server in servers:server.shutdown();server.server_close()
    (ROOT/'tests/contrato/relatorios/proxy.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':main()
