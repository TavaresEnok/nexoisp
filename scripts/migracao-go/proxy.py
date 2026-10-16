#!/usr/bin/env python3
"""Valida o inventário e gera Caddy; não recarrega nem altera serviços."""
import argparse
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[2]
TABLE=ROOT/'infra/prod/caddy/rotas.yaml'
IMPLEMENTED=ROOT/'apps/api-go/rotas.json'
STATES={'fastify','go-canario','go','go-consolidada'}


def inventory():
    result=[]
    for line in (ROOT/'docs/migracao-go/INVENTARIO_ROTAS.md').read_text().splitlines():
        fields=[x.strip() for x in line.strip('|').split(' | ')]
        if len(fields)==9 and fields[0] in {'GET','POST','PUT','PATCH','DELETE'}:
            result.append({'method':fields[0],'path':fields[1].strip('`'),'phase':int(fields[7][1:])})
    assert len(result)==344,'inventário incompleto'
    return result


def load(path=TABLE):
    routes=json.loads(Path(path).read_text())['routes']
    expected={(r['method'],r['path']) for r in inventory()}
    keys=[(r['method'],r['path']) for r in routes]
    if len(keys)!=len(set(keys)) or set(keys)!=expected:raise ValueError('tabela precisa conter as 344 rotas, sem duplicatas')
    implemented={(r['method'],r['path']) for r in json.loads(IMPLEMENTED.read_text())['routes']}
    for r in routes:
        if r['state'] not in STATES:raise ValueError('estado inválido: '+r['path'])
        if r['state']!='fastify' and (r['method'],r['path']) not in implemented:raise ValueError('rota sem implementação Go: '+r['path'])
        if r['state']=='go-canario' and (type(r.get('percent')) is not int or r['percent'] not in {1,10,50}):raise ValueError('canário precisa ser 1, 10 ou 50%')
        if r['path'].startswith('/agent/') and r['state']!='fastify':raise ValueError('agentes usam mTLS direto, fora do Caddy')
    return routes


def generate(routes):
    out=['# Gerado por scripts/migracao-go/proxy.py; edite rotas.yaml.','{$NEXO_DOMAIN:localhost} {','  log {','    format json','  }','  route {']
    for i,r in enumerate(routes):
        if r['path'].startswith('/agent/'):continue
        # Segmentos de parâmetros não podem capturar barra nem rotas irmãs.
        pattern='^'+'/'.join('[^/]+' if part.startswith(':') else re.escape(part) for part in r['path'].split('/'))+'$'
        method=r['method']+(' HEAD' if r['method']=='GET' else '')
        label=r['method']+' '+r['path']
        out += [f'    @r{i} {{',f'      method {method}',f'      path_regexp r{i} {pattern}','    }',f'    handle @r{i} {{',f'      log_append nexo_route "{label}"']
        if r['state']=='fastify':upstreams='{$NEXO_FASTIFY_UPSTREAM:api:8080}'
        elif r['state'] in {'go','go-consolidada'}:upstreams='{$NEXO_GO_UPSTREAM:api-go:8080}'
        else:upstreams='{$NEXO_FASTIFY_UPSTREAM:api:8080} {$NEXO_GO_UPSTREAM:api-go:8080}'
        out += ['      log_append nexo_upstream {http.reverse_proxy.upstream.address}',f'      reverse_proxy {upstreams} {{']
        if r['state']=='go-canario':out += [f'        lb_policy weighted_round_robin {100-r["percent"]} {r["percent"]}']
        # Uma falha de transporte não reenvia uma escrita cujo commit pode ter ocorrido.
        out += ['        lb_try_duration 0','      }','    }']
    out += ['    @backend path /api /api/* /public /public/* /aviso /aviso/*','    handle @backend {','      log_append nexo_route unmatched-api','      log_append nexo_upstream {http.reverse_proxy.upstream.address}','      reverse_proxy {$NEXO_FASTIFY_UPSTREAM:api:8080}','    }','    handle {','      log_append nexo_route static','      log_append nexo_upstream caddy','      header {','        X-Content-Type-Options nosniff','        X-Frame-Options DENY','        Referrer-Policy same-origin','        Permissions-Policy "camera=(), microphone=(), geolocation=(self), payment=()"', '      }','      header {','        match header Content-Type text/html*','        Content-Security-Policy "default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob: https://tile.openstreetmap.org; connect-src \'self\'; object-src \'none\'; base-uri \'self\'; form-action \'self\'; frame-ancestors \'none\'"','      }','      @https protocol https','      header @https Strict-Transport-Security max-age=31536000','      root * {$NEXO_WEB_ROOT:/srv}','      try_files {path} /index.html','      file_server','    }','  }','}']
    return '\n'.join(out)+'\n'


def main():
    p=argparse.ArgumentParser();p.add_argument('--init',action='store_true');p.add_argument('--table',default=str(TABLE));p.add_argument('--output',default=str(ROOT/'infra/prod/caddy/Caddyfile'));p.add_argument('--check',action='store_true');a=p.parse_args()
    if a.init:
        target=Path(a.table)
        if target.exists():raise ValueError('tabela já existe')
        target.write_text(json.dumps({'version':1,'routes':[dict(r,state='fastify') for r in inventory()]},ensure_ascii=False,indent=2)+'\n')
    content=generate(load(a.table));target=Path(a.output)
    if a.check:
        if target.read_text()!=content:raise ValueError('Caddyfile desatualizado')
    else:target.write_text(content)
    print('Proxy: 344 rotas validadas; '+str(target))

if __name__=='__main__':main()
