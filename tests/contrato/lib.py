"""Utilitários do laboratório descartável; nunca usa .env do produto."""
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCAL = Path(__file__).resolve().parent / 'local'
DB_CONTAINER = os.getenv('NEXO_CONTRATO_DB_CONTAINER', 'nexo-fase1-db')
DB_PORT = int(os.getenv('NEXO_CONTRATO_DB_PORT', '15439'))
DB_NAME = 'nexo_contrato_lab'


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def sql(query, database=DB_NAME):
    if database not in (DB_NAME, 'nexo_contrato_novo', 'nexo_contrato_legado', 'nexo_contrato_parcial', 'nexo_contrato_carga', 'nexo_contrato_carga_lab', 'postgres'):
        raise ValueError('banco fora do laboratório')
    p = command(['docker', 'exec', '-i', DB_CONTAINER, 'psql', '-X', '-qAt',
                 '-v', 'ON_ERROR_STOP=1', '-p', str(DB_PORT), '-U', 'nexo_owner', '-d', database],
                input=query, capture_output=True)
    return p.stdout.strip()


def records(query):
    return json.loads(sql('select coalesce(json_agg(r),\'[]\') from (' + query + ') r'))


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def request(base, path, token=None, cookie=False, method='GET', headers=None, body=None):
    h = dict(headers or {})
    if token is not None:
        if cookie:
            h['Cookie'] = 'nexo_session=' + token
        else:
            h['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(base + path, data=body, headers=h, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as exc:
        response = exc
    raw = response.read()
    try:
        parsed = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        parsed = None
    return {'status': response.status, 'headers': dict((k.lower(), v) for k, v in response.headers.items()),
            'json': parsed, 'body': raw}


def go_env(database=DB_NAME):
    return dict(os.environ, DATABASE_URL_OWNER=f'postgres://nexo_owner:fase1-owner-local@127.0.0.1:{DB_PORT}/{database}',
                DATABASE_URL_GO=f'postgres://nexo_go:fase1-go-local@127.0.0.1:{DB_PORT}/{database}',
                DATABASE_URL_APP=f'postgres://nexo_app:fase1-app-local@127.0.0.1:{DB_PORT}/{database}',
                NEXO_GO_DB_PASSWORD='fase1-go-local', NEXO_APP_DB_PASSWORD='fase1-app-local',
                NEXO_REQUIRE_ADMIN_MFA='1', NEXO_AGENT_MTLS='off')
