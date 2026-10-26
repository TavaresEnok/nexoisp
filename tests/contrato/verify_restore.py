#!/usr/bin/env python3
"""Verification callback for the disposable recovery test, including real login."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse

from lib import request, wait

database=sys.argv[1]
env=dict(os.environ,NEXO_RESTORE_DATABASE=database)
root=Path(__file__).resolve().parents[2]
subprocess.run([str(root/'apps/api-go/bin/nexo-db'),'verify-restore'],env=env,cwd=root,check=True)
# This callback is exclusively used by resilience.py with fictitious accounts.
parts=urllib.parse.urlsplit(env['DATABASE_URL_GO'])
env.update(DATABASE_URL_GO=urllib.parse.urlunsplit(parts._replace(path='/'+database)),
           NEXO_GO_ADDR='127.0.0.1:18951',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19951',
           NEXO_GO_AGENT_ADDR='127.0.0.1:18952',NEXO_GO_JOBS='0')
with tempfile.TemporaryFile() as log:
    process=subprocess.Popen([str(root/'apps/api-go/bin/api')],env=env,cwd=root,stdout=log,stderr=subprocess.STDOUT)
    try:
        wait('http://127.0.0.1:19951','/healthz',process)
        login=request('http://127.0.0.1:18951','/api/auth/login',method='POST',
                      headers={'Content-Type':'application/json'},
                      body=json.dumps({'email':'admin@alfa.demo','password':'demo1234','bearer':True}).encode())
        assert login['status']==200
        me=request('http://127.0.0.1:18951','/api/me',token=login['json']['token'])
        assert me['status']==200 and me['json']['email']=='admin@alfa.demo'
        print('restauração: login e sessão reais conferidos na API Go isolada')
    finally:
        process.terminate();process.wait(timeout=15)
