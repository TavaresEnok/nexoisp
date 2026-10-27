"""Utilitários do laboratório descartável; nunca usa .env do produto."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import sys
import traceback
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCAL = Path(__file__).resolve().parent / 'local'
DB_CONTAINER = os.getenv('NEXO_CONTRATO_DB_CONTAINER', 'nexo-fase1-db')
DB_PORT = int(os.getenv('NEXO_CONTRATO_DB_PORT', '15439'))
DB_NAME = 'nexo_contrato_lab'
# A clean checkout has no ignored output directory. Child contracts must be able
# to write evidence before the parent finishes its own report.
(ROOT / 'tests/contrato/relatorios').mkdir(parents=True, exist_ok=True)


# Child contracts run as separate Python processes. Surface their exact failing
# source location to hosted checks without publishing exception/response values.
if os.getenv('GITHUB_ACTIONS') == 'true':
    def _annotate_contract_failure(exc_type, value, tb):
        for frame in traceback.extract_tb(tb):
            path = Path(frame.filename).resolve()
            if path.is_relative_to(ROOT):
                message = (exc_type.__name__ + ': ' + (frame.line or frame.name))
                message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
                print(f'::error file={path.relative_to(ROOT)},line={frame.lineno},title=Contrato isolado::{message}', flush=True)
        sys.__excepthook__(exc_type, value, tb)
    sys.excepthook = _annotate_contract_failure


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def sql(query, database=DB_NAME):
    if database not in (DB_NAME, 'nexo_contrato_novo', 'nexo_contrato_legado', 'nexo_contrato_parcial', 'nexo_contrato_carga', 'nexo_contrato_carga_lab', 'nexo_test', 'postgres'):
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


def go(*args, **kwargs):
    env = dict(kwargs.pop('env', os.environ))
    if args and args[0] == 'build':
        env['CGO_ENABLED'] = '0'
    kwargs['env'] = env
    executable = os.getenv('NEXO_GO_BIN') or shutil.which('go')
    if executable:
        return command([executable, *args], cwd=ROOT / 'apps/api-go', **kwargs)
    cache = LOCAL / 'go-cache'
    cache.mkdir(exist_ok=True, parents=True)
    image = 'nexo-fase1-go-tools:local'
    if subprocess.run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        with tempfile.TemporaryDirectory(prefix='nexo-go-tools-') as temp:
            shutil.copyfile(ROOT / 'tests/contrato/Dockerfile.tools', Path(temp) / 'Dockerfile')
            command(['docker', 'build', '--network', 'host', '-t', image, temp])
    return command(['docker', 'run', '--rm', '--network', 'host', '--security-opt', 'seccomp=unconfined',
                    '-v', str(ROOT) + ':/app', '-v', str(cache) + ':/go', '-w', '/app/apps/api-go',
                    '-e', 'DATABASE_URL_OWNER', '-e', 'NEXO_GO_DB_PASSWORD', '-e', 'NEXO_APP_DB_PASSWORD',
                    '-e', 'NEXO_GO_TEST_DATABASE_URL', '-e', 'CGO_ENABLED', image, 'go', *args], **kwargs)


def wait(base, path, process=None):
    for _ in range(100):
        if process and process.poll() is not None:
            raise RuntimeError('processo encerrou; veja tests/contrato/local')
        try:
            if request(base, path)['status'] == 200:
                return
        except OSError:
            pass
        time.sleep(.1)
    raise RuntimeError('serviço não ficou pronto: ' + base)
