#!/usr/bin/env python3
"""External HTTP, complete backup age and filesystem checks. Nonzero on failure."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect recusado', headers, fp)


def check(url, timeout, backup_dir=None, max_age=26*3600, min_free=10):
    parsed=urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('URL de saúde não pode conter credenciais, query ou fragmento')
    if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in ('127.0.0.1','localhost','::1')):
        raise ValueError('monitor externo exige HTTPS')
    checks={}
    try:
        with urllib.request.build_opener(NoRedirect).open(url,timeout=timeout) as response:
            payload=json.loads(response.read(4096))
            checks['api']=response.status==200 and payload.get('ok') is True and payload.get('db')=='ok'
    except Exception:
        checks['api']=False
    details={}
    if backup_dir:
        directory=Path(backup_dir)
        try:
            usage=shutil.disk_usage(directory)
            details['disk_free_percent']=round(100*usage.free/usage.total,2)
            checks['disk']=details['disk_free_percent']>=min_free
            complete=[p for p in directory.glob('*.dump') if Path(str(p)+'.sha256').is_file() and Path(str(p)+'.manifest.json').is_file()]
            age=time.time()-max((p.stat().st_mtime for p in complete),default=0)
            details['backup_age_seconds']=round(age)
            checks['recent_complete_backup']=age<=max_age
        except OSError:
            checks['disk']=checks['recent_complete_backup']=False
    return {'ok':all(checks.values()),'checks':checks,**details}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',required=True,help='https://painel.exemplo/api/health')
    parser.add_argument('--timeout',type=float,default=5)
    parser.add_argument('--backup-dir')
    parser.add_argument('--max-backup-age-hours',type=float,default=26)
    parser.add_argument('--min-free-percent',type=float,default=10)
    args=parser.parse_args()
    if args.timeout<=0 or args.max_backup_age_hours<=0 or not 0<args.min_free_percent<100:
        parser.error('limiares inválidos')
    try:
        result=check(args.url,args.timeout,args.backup_dir,args.max_backup_age_hours*3600,args.min_free_percent)
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(result,sort_keys=True))
    return 0 if result['ok'] else 1

if __name__=='__main__':
    sys.exit(main())
