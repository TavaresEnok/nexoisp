#!/usr/bin/env python3
"""Handshake e fixação de certificado no listener Go, com CA efêmera do laboratório."""
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from lib import ROOT, LOCAL, go_env, records
from consolidacao import call, GO
from laboratorio import wait

u=records("select id from users where email like '%-admin@contrato.invalid' order by id limit 1")[0]
a=call(GO,'/api/agents','contrato:'+u['id'],{'name':'mTLS Go '+uuid.uuid4().hex[:10]})
assert a['status']==200,a['json']
a=a['json']
with tempfile.TemporaryDirectory(prefix='nexo-mtls-go-') as temporary:
 d=Path(temporary)
 def openssl(*args):subprocess.run(['openssl',*args],cwd=d,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','1','-subj','/CN=Nexo-lab-CA')
 def cert(name,cn,server=False):
  openssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+cn)
  ext=['subjectAltName=DNS:localhost,IP:127.0.0.1','extendedKeyUsage=serverAuth'] if server else ['extendedKeyUsage=clientAuth']
  (d/(name+'.ext')).write_text('\n'.join(ext)+'\n')
  openssl('x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',name+'.crt','-days','1','-extfile',name+'.ext')
 cert('server','localhost',True)
 cert('agent','agent:'+a['id'])
 cert('replacement','agent:'+a['id'])
 cert('wrong','agent:'+str(uuid.uuid4()))
 env=dict(go_env(),NEXO_GO_ADDR='127.0.0.1:18085',NEXO_GO_INTERNAL_ADDR='127.0.0.1:19085',NEXO_GO_AGENT_ADDR='127.0.0.1:18444',NEXO_AGENT_MTLS='on',NEXO_AGENT_TLS_DIR=temporary)
 log=open(LOCAL/'mtls-go.log','w')
 p=subprocess.Popen([str(ROOT/'apps/api-go/bin/api')],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
 try:
  wait('http://127.0.0.1:19085','/healthz',p)
  def hello(name):
   ctx=ssl.create_default_context(cafile=str(d/'ca.crt'))
   if name:ctx.load_cert_chain(str(d/(name+'.crt')),str(d/(name+'.key')))
   req=urllib.request.Request('https://localhost:18444/agent/v1/hello',data=json.dumps({'session_id':'mtls-lab-session','version':'0.5.0'}).encode(),headers={'content-type':'application/json','authorization':'Bearer '+a['token']},method='POST')
   try:return urllib.request.urlopen(req,context=ctx,timeout=5).status
   except urllib.error.HTTPError as e:return e.code
  assert hello('agent')==200
  assert hello('replacement')==401
  assert hello('wrong')==401
  try:hello(None)
  except (urllib.error.URLError,ssl.SSLError,OSError):pass
  else:raise AssertionError('listener aceitou conexão sem certificado')
  print('mTLS Go: CA, identidade, fixação e rejeição sem certificado passaram')
 finally:
  p.terminate()
  try:p.wait(timeout=15)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close()
