#!/usr/bin/env python3
"""Bounded, read-only HTTP capacity sample for an explicitly selected laboratory."""
import argparse
import concurrent.futures
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect recusado', headers, fp)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--base',required=True)
    parser.add_argument('--laboratory',action='store_true',required=True)
    parser.add_argument('--requests',type=int,default=100)
    parser.add_argument('--concurrency',type=int,default=4)
    parser.add_argument('--max-p95-ms',type=float,default=1000)
    args=parser.parse_args()
    url=urllib.parse.urlsplit(args.base)
    if url.scheme not in ('http','https') or not url.hostname or url.username or url.password or url.path not in ('','/') or url.query or url.fragment:
        parser.error('base deve conter somente protocolo e host, sem credenciais')
    token=os.environ.get('NEXO_CAPACITY_TOKEN')
    if not token: parser.error('defina NEXO_CAPACITY_TOKEN no ambiente, nunca na linha de comando')
    if not 1<=args.requests<=10000 or not 1<=args.concurrency<=32 or args.max_p95_ms<=0:
        parser.error('limites: 1–10000 consultas; 1–32 concorrentes; p95 positivo')
    def read(index):
        start=time.perf_counter()
        req=urllib.request.Request(args.base.rstrip('/')+'/api/subscribers?limit=20',headers={'Authorization':'Bearer '+token})
        try:
            with urllib.request.build_opener(NoRedirect).open(req,timeout=15) as response:
                response.read();status=response.status
        except urllib.error.HTTPError as error:
            status=error.code
        except OSError:
            status=0
        return status,(time.perf_counter()-start)*1000
    start=time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(args.concurrency) as pool:
        samples=list(pool.map(read,range(args.requests)))
    elapsed=time.perf_counter()-start
    times=sorted(ms for _,ms in samples);p95=times[math.ceil(len(times)*.95)-1]
    statuses={str(code):sum(s==code for s,_ in samples) for code,_ in samples}
    result={'ok':all(code==200 for code,_ in samples) and p95<=args.max_p95_ms,
            'requests':len(samples),'concurrency':args.concurrency,'statuses':statuses,
            'p95_ms':round(p95,2),'requests_per_second':round(len(samples)/elapsed,2),
            'scope':'consulta paginada; não estabelece SLA nem capacidade de RADIUS'}
    print(json.dumps(result,ensure_ascii=False));return 0 if result['ok'] else 1

if __name__=='__main__':
    raise SystemExit(main())
