#!/usr/bin/env python3
"""Ensaio B12: backup sintético restaurado num cluster vazio e exclusivo.

Não lê .env, não usa nexoisp-db-1 nem nexoisp-prod e não copia papéis do
cluster de origem. A prova criptográfica é o nexo-db verify-restore já
existente. O manifesto, a soma e o SQL de isolamento são os de scripts/.
Teste estático não aprova este critério. Sem Docker e PostgreSQL o processo
termina com erro, sem skip.

Limites: não homologa host físico, cópia externa, RPO/RTO produtivo,
Backup-center nem piloto. Fila persistida com jobs desligados não é
exactly-once de transporte externo.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / 'tests' / 'contrato' / 'relatorios' / 'restore-clean-host.json'
IMAGE = 'postgres:16-alpine'
LAB_LABEL = 'b12-clean-host'
FORBIDDEN_NAMES = frozenset({
    'nexoisp-db-1', 'nexoisp-prod', 'nexo-fase1-db', 'nexo-resilience-db', 'nexo',
})
FORBIDDEN_PORTS = frozenset({5432, 5433, 15439, 15679, 18082, 19082})
PRODUCT_ENV = frozenset({
    'DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_URL_GO', 'DATABASE_URL_APP',
    'NEXO_DB_CONTAINER', 'NEXO_DB_PORT', 'NEXO_PROD_ENV_FILE', 'NEXO_SECRET_KEY',
    'NEXO_SECRET_KEY_PREVIOUS', 'NEXO_RADIUS_KEY', 'NEXO_BACKUP_COPY',
    'NEXO_API_SERVICE_STOP', 'NEXO_API_SERVICE_START', 'PGPASSWORD', 'PGHOST',
    'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGPASSFILE',
})
TOOLCHAIN_KEYS = frozenset({
    'PATH', 'HOME', 'XDG_CACHE_HOME', 'GOROOT', 'GOPROXY', 'GOSUMDB',
    'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GO111MODULE', 'GOFLAGS', 'GOTOOLCHAIN',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
})
NAME_RE = re.compile(r'^nexo-b12-(src|dst)-[0-9a-f]{12}$')
VOLUME_RE = re.compile(r'^nexo-b12-(src|dst)-vol-[0-9a-f]{12}$')
RESTORE_DB_RE = re.compile(r'^nexo_restore_check_[0-9]+_[0-9]+$')
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
RUNTIME_MISSING = (
    'B12 exige Docker, Go e PostgreSQL; o ensaio não foi executado e teste estático não aprova este critério'
)
LIMITS = [
    'não homologa host físico',
    'não prova cópia externa nem NEXO_BACKUP_COPY',
    'não mede RPO nem RTO produtivo',
    'não integra Backup-center',
    'não homologa o piloto',
    'persistência de fila com jobs desligados não é exactly-once externo',
    'destino vazio simulado não substitui cluster físico nem cofre',
]
REQUIRED_PHASES = [
    'identidade',
    'origem sintética',
    'backup manifesto e soma',
    'bootstrap do destino',
    'restore no cluster vazio',
    'manifesto conferido',
    'isolamento e grants',
    'documentos por bytes',
    'verify-restore',
    'chave errada recusada',
    'login e sessão',
    'download HTTP e recusa entre tenants',
    'portal e POP',
    'fila persistida sem execução',
    'retomada com jobs desligados',
    'replay da compensação B13',
    'manipulação recusada',
]
REFUSAL_KINDS = ('checksum-manifesto', 'dump-manipulado')


class RestoreRefused(RuntimeError):
    """Destino, identidade ou artefato recusado antes de tratar a corrida como sucesso."""


class Spec:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)

    def secrets(self):
        values = ['b12-radius-sintetica', 'demo1234']
        for name, value in self.__dict__.items():
            if value and any(part in name for part in ('password', 'key', 'aes')):
                values.append(str(value))
        return values


def sample_spec():
    """Identidade fixa para testes que não abrem Docker."""
    run_id = 'a1b2c3d4e5f6'
    passwords = [format(index, 'x') * 32 for index in range(1, 10)]
    return Spec(
        run_id=run_id,
        source_container=f'nexo-b12-src-{run_id}',
        dest_container=f'nexo-b12-dst-{run_id}',
        source_volume=f'nexo-b12-src-vol-{run_id}',
        dest_volume=f'nexo-b12-dst-vol-{run_id}',
        source_port=25111,
        dest_port=25112,
        source_api_port=25113,
        dest_api_port=25114,
        source_internal_port=25115,
        dest_internal_port=25116,
        source_owner_password=passwords[0],
        dest_owner_password=passwords[1],
        source_go_password=passwords[2],
        dest_go_password=passwords[3],
        source_app_password=passwords[4],
        dest_app_password=passwords[5],
        source_radius_db_password=passwords[6],
        dest_radius_db_password=passwords[7],
        source_replica_password=passwords[8],
        dest_replica_password='a' * 32,
        aes_key=base64.b64encode(b'0123456789abcdef0123456789abcdef').decode(),
        radius_key='chave-radius-sintetica-b12-demo',
        signing_key='',
        env_file=None,
        image=IMAGE,
        label=LAB_LABEL,
        source_database='nexo_b12_source',
        dest_database='nexo_restore_check_4242_7',
        work_dir=None,
    )


def new_spec():
    run_id = secrets.token_hex(6)
    ports = _distinct_ports(6)
    suffix = secrets.token_hex(4)
    return Spec(
        run_id=run_id,
        source_container=f'nexo-b12-src-{run_id}',
        dest_container=f'nexo-b12-dst-{run_id}',
        source_volume=f'nexo-b12-src-vol-{run_id}',
        dest_volume=f'nexo-b12-dst-vol-{run_id}',
        source_port=ports[0],
        dest_port=ports[1],
        source_api_port=ports[2],
        dest_api_port=ports[3],
        source_internal_port=ports[4],
        dest_internal_port=ports[5],
        source_owner_password=secrets.token_hex(16),
        dest_owner_password=secrets.token_hex(16),
        source_go_password=secrets.token_hex(16),
        dest_go_password=secrets.token_hex(16),
        source_app_password=secrets.token_hex(16),
        dest_app_password=secrets.token_hex(16),
        source_radius_db_password=secrets.token_hex(16),
        dest_radius_db_password=secrets.token_hex(16),
        source_replica_password=secrets.token_hex(16),
        dest_replica_password=secrets.token_hex(16),
        aes_key=base64.b64encode(secrets.token_bytes(32)).decode(),
        radius_key='chave-radius-sintetica-b12-' + suffix,
        signing_key='',
        env_file=None,
        image=IMAGE,
        label=LAB_LABEL,
        source_database='nexo_b12_source',
        dest_database=f'nexo_restore_check_{os.getpid()}_{secrets.randbelow(90000) + 1}',
        work_dir=None,
    )


def _distinct_ports(count, taken=None):
    chosen = set(taken or ())
    ports = []
    while len(ports) < count:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        if port in FORBIDDEN_PORTS or port in chosen:
            continue
        chosen.add(port)
        ports.append(port)
    return ports


def assert_lab_identity(spec):
    """Recusa destino herdado, nome reservado ou par origem/destino incompleto."""
    pairs = (
        ('source_container', spec.source_container, NAME_RE, 'src'),
        ('dest_container', spec.dest_container, NAME_RE, 'dst'),
        ('source_volume', spec.source_volume, VOLUME_RE, 'src'),
        ('dest_volume', spec.dest_volume, VOLUME_RE, 'dst'),
    )
    seen = set()
    for field, value, pattern, role in pairs:
        if not isinstance(value, str) or not pattern.match(value):
            raise RestoreRefused(f'nome de laboratório recusado: {field}')
        if value in FORBIDDEN_NAMES or value.startswith('nexoisp') or 'prod' in value:
            raise RestoreRefused(f'nome reservado recusado: {field}')
        if not value.endswith(spec.run_id) or f'-{role}-' not in value:
            raise RestoreRefused(f'nome sem a execução atual: {field}')
        if value in seen:
            raise RestoreRefused('origem e destino compartilham recurso')
        seen.add(value)
    if spec.source_container == spec.dest_container or spec.source_volume == spec.dest_volume:
        raise RestoreRefused('origem e destino compartilham recurso')
    if spec.label != LAB_LABEL or spec.image != IMAGE:
        raise RestoreRefused('rótulo ou imagem fora do contrato do ensaio')
    if spec.env_file is not None or (spec.work_dir and '.env' in str(spec.work_dir)):
        raise RestoreRefused('configuração de arquivo .env recusada')
    ports = [
        spec.source_port, spec.dest_port, spec.source_api_port, spec.dest_api_port,
        spec.source_internal_port, spec.dest_internal_port,
    ]
    if len(set(ports)) != len(ports):
        raise RestoreRefused('portas de origem e destino coincidem')
    for port in ports:
        if not isinstance(port, int) or port < 1024 or port > 65535 or port in FORBIDDEN_PORTS:
            raise RestoreRefused('porta herdada ou reservada recusada')
    if spec.source_database != 'nexo_b12_source' or RESTORE_DB_RE.match(spec.source_database):
        raise RestoreRefused('banco de origem fora do contrato')
    if not RESTORE_DB_RE.match(spec.dest_database) or spec.dest_database == spec.source_database:
        raise RestoreRefused('banco de destino fora do contrato de verify-restore')
    passwords = {
        'source_owner': spec.source_owner_password,
        'dest_owner': spec.dest_owner_password,
        'source_go': spec.source_go_password,
        'dest_go': spec.dest_go_password,
        'source_app': spec.source_app_password,
        'dest_app': spec.dest_app_password,
        'source_radius_db': spec.source_radius_db_password,
        'dest_radius_db': spec.dest_radius_db_password,
        'source_replica': spec.source_replica_password,
        'dest_replica': spec.dest_replica_password,
    }
    if len(set(passwords.values())) != len(passwords):
        raise RestoreRefused('senhas de origem e destino não são independentes')
    for value in passwords.values():
        if not re.fullmatch(r'[0-9a-f]{32}', value):
            raise RestoreRefused('senha de laboratório fora do alfabeto explícito')
    try:
        raw_key = base64.b64decode(spec.aes_key, validate=True)
    except (ValueError, TypeError):
        raw_key = b''
    if len(raw_key) != 32:
        raise RestoreRefused('chave AES sintética ausente ou inválida')
    if not spec.radius_key.startswith('chave-radius-sintetica-b12-') or len(spec.radius_key) < 24:
        raise RestoreRefused('chave RADIUS sintética ausente')
    if spec.work_dir is not None:
        work = Path(spec.work_dir)
        if not work.is_absolute() or spec.run_id not in work.name or '.env' in str(work):
            raise RestoreRefused('diretório de trabalho fora desta execução')
    blob = json.dumps({key: value for key, value in spec.__dict__.items() if 'password' not in key and 'key' not in key and key != 'aes_key'})
    if 'nexoisp-db-1' in blob or 'nexoisp-prod' in blob or '.env' in blob:
        raise RestoreRefused('identidade contém destino herdado')


def begin_mutations(spec, mutate):
    """Identidade primeiro. mutate só corre depois da aceitação."""
    assert_lab_identity(spec)
    return mutate()


def refuse_if_present(name, inspect_code):
    if name in FORBIDDEN_NAMES or name.startswith('nexoisp') or not (NAME_RE.match(name) or VOLUME_RE.match(name)):
        raise RestoreRefused('recurso recusado antes de inspecionar mutação')
    if inspect_code == 0:
        raise RestoreRefused('recurso já existe; abortado antes de reutilizar ou apagar')


def process_env(spec, cluster, ambient, database=None):
    """Monta o ambiente do processo a partir do spec. Chaves do ambiente herdado não entram."""
    assert_lab_identity(spec)
    if cluster not in ('source', 'destination'):
        raise RestoreRefused('cluster desconhecido')
    destination = cluster == 'destination'
    port = spec.dest_port if destination else spec.source_port
    if database is None:
        database = spec.dest_database if destination else spec.source_database
    elif database != 'postgres':
        raise RestoreRefused('banco de manutenção recusado')
    owner = spec.dest_owner_password if destination else spec.source_owner_password
    go_password = spec.dest_go_password if destination else spec.source_go_password
    app_password = spec.dest_app_password if destination else spec.source_app_password
    radius_db = spec.dest_radius_db_password if destination else spec.source_radius_db_password
    replica = spec.dest_replica_password if destination else spec.source_replica_password
    api_port = spec.dest_api_port if destination else spec.source_api_port
    internal_port = spec.dest_internal_port if destination else spec.source_internal_port

    def url(user, password, db):
        return 'postgres://' + user + ':' + urllib.parse.quote(password) + '@127.0.0.1:' + str(port) + '/' + db

    env = {'PATH': ambient.get('PATH') or '/usr/bin:/bin', 'LANG': 'C'}
    if spec.work_dir:
        env['HOME'] = spec.work_dir
        env['TMPDIR'] = spec.work_dir
    env.update(
        DATABASE_URL_OWNER=url('nexo_owner', owner, database),
        DATABASE_URL_GO=url('nexo_go', go_password, database),
        DATABASE_URL_APP=url('nexo_app', app_password, database),
        NEXO_GO_DB_PASSWORD=go_password,
        NEXO_APP_DB_PASSWORD=app_password,
        NEXO_RADIUS_DB_PASSWORD=radius_db,
        NEXO_REPLICA_PASSWORD=replica,
        NEXO_SECRET_KEY=spec.aes_key,
        NEXO_RADIUS_KEY=spec.radius_key,
        NEXO_DEMO_MODE='1',
        NEXO_REQUIRE_ADMIN_MFA='0',
        NEXO_COOKIE_SECURE='0',
        NEXO_GO_JOBS='0',
        NEXO_GO_ADDR=f'127.0.0.1:{api_port}',
        NEXO_GO_INTERNAL_ADDR=f'127.0.0.1:{internal_port}',
        NEXO_ALERT_WEBHOOK_URL='',
        NEXO_ACS_URL='',
        NEXO_ACS_PUBLIC_URL='',
        NEXO_BACKUP_COPY='',
        NODE_ENV='test',
    )
    if spec.signing_key:
        env['NEXO_OP_SIGNING_KEY'] = spec.signing_key
    blob = json.dumps(env)
    if 'nexoisp-db-1' in blob or 'nexoisp-prod' in blob or '.env' in blob:
        raise RestoreRefused('ambiente do processo contém destino herdado')
    return env


def toolchain_env(ambient):
    """Ambiente mínimo do `go build`.

    O setup-go do workflow não exporta GOPATH, GOMODCACHE nem GOCACHE. Sem HOME,
    o Go recusa o cache (`neither GOMODCACHE nor GOPATH is set`). HOME real deixa
    o arquivo `go env` valer; se essas três variáveis não vierem no ambiente,
    valem os defaults de Go sob esse HOME. DATABASE*, NEXO_* e PG* ficam de fora.
    """
    env = {key: ambient[key] for key in TOOLCHAIN_KEYS if ambient.get(key)}
    env['CGO_ENABLED'] = '0'
    env['PATH'] = env.get('PATH') or '/usr/bin:/bin'
    if not env.get('HOME'):
        home = os.environ.get('HOME')
        if not home:
            try:
                home = str(Path.home())
            except RuntimeError:
                home = ''
        if home:
            env['HOME'] = home
    home = env.get('HOME') or ''
    if home and not env.get('GOPATH'):
        env['GOPATH'] = str(Path(home) / 'go')
    if home and not env.get('GOMODCACHE'):
        first = (env.get('GOPATH') or str(Path(home) / 'go')).split(os.pathsep)[0]
        env['GOMODCACHE'] = str(Path(first) / 'pkg' / 'mod')
    if home and not env.get('GOCACHE'):
        cache_root = env.get('XDG_CACHE_HOME') or str(Path(home) / '.cache')
        env['GOCACHE'] = str(Path(cache_root) / 'go-build')
    for key in list(env):
        if key in PRODUCT_ENV or key.startswith('NEXO_') or key.startswith('DATABASE') or key.startswith('PG'):
            raise RestoreRefused('toolchain recebeu configuração de produto')
    return env


def checksum_valid(dump):
    dump = Path(dump)
    sidecar = Path(str(dump) + '.sha256')
    manifest = Path(str(dump) + '.manifest.json')
    if not dump.is_file() or not sidecar.is_file() or not manifest.is_file():
        return False
    expected = {}
    for line in sidecar.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r'[0-9a-f]{64}', parts[0]):
            return False
        expected[parts[1]] = parts[0]
    wanted = {dump.name, manifest.name}
    if set(expected) != wanted:
        return False
    for path in (dump, manifest):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if expected[path.name] != digest:
            return False
    return True


def write_checksum(dump):
    dump = Path(dump)
    manifest = Path(str(dump) + '.manifest.json')
    lines = []
    for path in (dump, manifest):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f'{digest}  {path.name}')
    sidecar = Path(str(dump) + '.sha256')
    sidecar.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    for path in (dump, manifest, sidecar):
        os.chmod(path, 0o600)
    return sidecar


def require_checksum(dump):
    if not checksum_valid(dump):
        raise RestoreRefused('soma de verificação ausente ou inválida')


def restore_authenticated(spec, dump, mutate):
    assert_lab_identity(spec)
    require_checksum(dump)
    return mutate()


def note_outcome(kind, ok):
    if kind in REFUSAL_KINDS and ok:
        raise RestoreRefused('manipulação não pode ser registrada como restauração bem-sucedida')
    return ok


def allow_success(phases, refusals):
    if list(refusals) != list(REFUSAL_KINDS):
        return False
    return all(phase in phases for phase in REQUIRED_PHASES)


def cleanup_plan(items, run_id):
    plan = []
    for item in items:
        name = item.get('name')
        if item.get('run') != run_id or item.get('label') != LAB_LABEL:
            raise RestoreRefused('limpeza recusou recurso de outra execução')
        if item.get('kind') not in ('container', 'volume'):
            raise RestoreRefused('limpeza recusou tipo desconhecido')
        if name in FORBIDDEN_NAMES or not isinstance(name, str) or name.startswith('nexoisp') or not name.endswith(run_id):
            raise RestoreRefused('limpeza recusou nome reservado')
        if item['kind'] == 'container' and not NAME_RE.match(name):
            raise RestoreRefused('limpeza recusou container fora do padrão')
        if item['kind'] == 'volume' and not VOLUME_RE.match(name):
            raise RestoreRefused('limpeza recusou volume fora do padrão')
        plan.append({'kind': item['kind'], 'name': name})
    return plan


def require_runtime(which=shutil.which, run=subprocess.run):
    if which('docker') is None or which('go') is None or which('openssl') is None:
        raise SystemExit(RUNTIME_MISSING)
    info = run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if info.returncode != 0:
        raise SystemExit(RUNTIME_MISSING)
    image = run(['docker', 'image', 'inspect', IMAGE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if image.returncode != 0:
        pull = run(['docker', 'pull', IMAGE], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if pull.returncode != 0:
            raise SystemExit(RUNTIME_MISSING)
    return True


def redact(text, secrets_list):
    cleaned = text or ''
    for secret in secrets_list:
        if secret:
            cleaned = cleaned.replace(secret, '[omitido]')
    return cleaned


def _checked(argv, spec, env=None, input_bytes=None, cwd=None):
    result = subprocess.run(argv, input=input_bytes, cwd=cwd, env=env, capture_output=True)
    if result.returncode != 0:
        detail = redact((result.stderr or b'').decode('utf-8', 'replace')[-1500:], spec.secrets() if spec else [])
        raise RuntimeError('comando recusou status ' + str(result.returncode) + ': ' + detail)
    return result


def _inspect_code(name):
    return subprocess.run(['docker', 'inspect', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def _create_volume(spec, name, role):
    refuse_if_present(name, _inspect_code(name))
    _checked([
        'docker', 'volume', 'create',
        '--label', f'nexo.lab={LAB_LABEL}',
        '--label', f'nexo.lab.run={spec.run_id}',
        '--label', f'nexo.lab.role={role}',
        name,
    ], spec)


def _create_container(spec, name, volume, published, password, role):
    refuse_if_present(name, _inspect_code(name))
    _checked([
        'docker', 'run', '-d', '--name', name,
        '--label', f'nexo.lab={LAB_LABEL}',
        '--label', f'nexo.lab.run={spec.run_id}',
        '--label', f'nexo.lab.role={role}',
        '-p', f'127.0.0.1:{published}:5432',
        '-e', 'POSTGRES_USER=nexo_owner',
        '-e', f'POSTGRES_PASSWORD={password}',
        '-e', 'POSTGRES_DB=postgres',
        '-v', f'{volume}:/var/lib/postgresql/data',
        IMAGE,
    ], spec)
    inspected = json.loads(subprocess.run(['docker', 'inspect', name], capture_output=True, check=True).stdout)
    labels = inspected[0]['Config']['Labels']
    if labels.get('nexo.lab') != LAB_LABEL or labels.get('nexo.lab.run') != spec.run_id or labels.get('nexo.lab.role') != role:
        raise RestoreRefused('container criado sem o rótulo desta execução')
    if inspected[0]['Name'] != '/' + name:
        raise RestoreRefused('container criado com outro nome')


def _wait_db(name):
    for _ in range(100):
        if subprocess.run(['docker', 'exec', name, 'pg_isready', '-p', '5432', '-U', 'nexo_owner'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(0.2)
    raise RuntimeError('PostgreSQL do ensaio não ficou pronto')


def _psql(spec, container, database, query):
    assert_lab_identity(spec)
    if container not in (spec.source_container, spec.dest_container):
        raise RestoreRefused('psql recusou container fora do ensaio')
    result = subprocess.run(
        ['docker', 'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-p', '5432', '-U', 'nexo_owner', '-d', database],
        input=query.encode(), capture_output=True,
    )
    if result.returncode != 0:
        detail = redact(result.stderr.decode('utf-8', 'replace')[-1500:], spec.secrets())
        raise RuntimeError('psql recusou: ' + detail)
    return result.stdout.decode('utf-8', 'replace').strip()


def _psql_json(spec, container, database, query):
    raw = _psql(spec, container, database, "select coalesce(json_agg(r), '[]'::json) from (" + query + ") r")
    return json.loads(raw or '[]')


def _qid(value):
    if not UUID_RE.match(value or ''):
        raise RestoreRefused('identificador inesperado')
    return "'" + value + "'"


def _http():
    folder = str(ROOT / 'tests' / 'contrato')
    if folder not in sys.path:
        sys.path.insert(0, folder)
    import lib
    return lib


def _wait_http(base, process, log_path, spec):
    for _ in range(300):
        if process.poll() is not None:
            tail = redact(log_path.read_text(encoding='utf-8', errors='replace')[-1500:], spec.secrets())
            raise RuntimeError('API encerrou antes do healthz: ' + tail)
        try:
            if _http().request(base, '/healthz')['status'] == 200:
                return
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError('API não ficou pronta')


def _stop_process(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _api(env, spec, log_path):
    log = open(log_path, 'w', encoding='utf-8')
    process = subprocess.Popen([str(ROOT / 'apps' / 'api-go' / 'bin' / 'api')], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    base = 'http://' + env['NEXO_GO_ADDR']
    internal = 'http://' + env['NEXO_GO_INTERNAL_ADDR']
    try:
        _wait_http(internal, process, log_path, spec)
    except Exception:
        _stop_process(process)
        log.close()
        raise
    return process, log, base


def _call(base, path, token=None, body=None, headers=None, method=None):
    extra = dict(headers or {})
    data = None
    if body is not None:
        extra.setdefault('Content-Type', 'application/json')
        data = json.dumps(body).encode()
    return _http().request(base, path, token=token, method=method or ('POST' if body is not None else 'GET'), headers=extra, body=data)


def _git_head():
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        return 'desconhecido'
    return result.stdout.strip()


def _write_report(payload):
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def _discover(spec):
    items = []
    for kind, argv in (
        ('container', ['docker', 'ps', '-aq', '--filter', f'label=nexo.lab.run={spec.run_id}']),
        ('volume', ['docker', 'volume', 'ls', '-q', '--filter', f'label=nexo.lab.run={spec.run_id}']),
    ):
        result = subprocess.run(argv, capture_output=True, text=True)
        if result.returncode != 0:
            continue
        for name in result.stdout.split():
            if kind == 'container':
                inspected = json.loads(subprocess.run(['docker', 'inspect', name], capture_output=True, check=True).stdout)
                labels = inspected[0]['Config']['Labels'] or {}
                items.append({'kind': 'container', 'name': inspected[0]['Name'].lstrip('/'), 'run': labels.get('nexo.lab.run'), 'label': labels.get('nexo.lab')})
            else:
                inspected = json.loads(subprocess.run(['docker', 'volume', 'inspect', name], capture_output=True, check=True).stdout)
                labels = inspected[0]['Labels'] or {}
                items.append({'kind': 'volume', 'name': inspected[0]['Name'], 'run': labels.get('nexo.lab.run'), 'label': labels.get('nexo.lab')})
    return items


def cleanup(spec):
    items = _discover(spec)
    plan = cleanup_plan(items, spec.run_id)
    for item in plan:
        if item['kind'] == 'container':
            subprocess.run(['docker', 'rm', '-f', item['name']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for item in plan:
        if item['kind'] == 'volume':
            subprocess.run(['docker', 'volume', 'rm', item['name']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _roles_ok(spec, container):
    rows = _psql_json(spec, container, 'postgres', "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname in ('nexo_owner','nexo_go','nexo_app','nexo_radius')")
    found = {row['rolname']: row for row in rows}
    for name in ('nexo_go', 'nexo_app', 'nexo_radius'):
        row = found.get(name)
        if not row or row['rolsuper'] or row['rolbypassrls'] or not row['rolcanlogin']:
            raise RuntimeError('papel de runtime privilegiado ou ausente: ' + name)
    owner = found.get('nexo_owner')
    if not owner or not owner['rolsuper']:
        raise RuntimeError('owner de laboratório ausente')


def _ownership_ok(spec, container, database):
    owned = _psql(spec, container, database, """
        select count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
          and pg_has_role('nexo_go', c.relowner, 'MEMBER')
    """)
    if owned != '0':
        raise RuntimeError('nexo_go é dono de tabela')
    app_owned = _psql(spec, container, database, """
        select count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')
          and pg_has_role('nexo_app', c.relowner, 'MEMBER')
    """)
    if app_owned != '0':
        raise RuntimeError('nexo_app é dono de tabela')


def _insert_river(spec, container, database):
    columns = _psql_json(spec, container, database, """
        select column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'nexo_jobs' and table_name = 'river_job'
    """)
    if not columns:
        raise RuntimeError('fila river ausente depois do prepare')
    values = {
        'kind': "'b12_persist'",
        'max_attempts': '3',
        'args': """'{"probe":"clean-host"}'::jsonb""",
        'metadata': "'{}'::jsonb",
        'queue': "'default'",
        'state': "'available'",
        'priority': '1',
        'attempt': '0',
    }
    missing = []
    for column in columns:
        if column['is_nullable'] == 'NO' and not column['column_default'] and column['column_name'] not in values:
            missing.append(column['column_name'])
    if missing:
        raise RuntimeError('fila river sem contrato de inserção: ' + ','.join(missing))
    listed = [name for name in values if any(column['column_name'] == name for column in columns)]
    sql = 'insert into nexo_jobs.river_job (' + ','.join(listed) + ') values (' + ','.join(values[name] for name in listed) + ") returning id::text || ' ' || state"
    return _psql(spec, container, database, sql)


def _queue_state(spec, container, database, notice_id, river_id):
    notice = _psql(spec, container, database, 'select status from notice_log where id = ' + str(int(notice_id)))
    river = _psql(spec, container, database, "select state || ' ' || coalesce(finalized_at::text, '') from nexo_jobs.river_job where id = " + str(int(river_id)))
    return notice, river


def _capture(spec, dump, env):
    manifest_env = {
        'PATH': env['PATH'],
        'HOME': env.get('HOME', '/tmp'),
        'NEXO_DB_CONTAINER': spec.source_container,
        'NEXO_DB_PORT': '5432',
    }
    _checked([sys.executable, str(ROOT / 'scripts' / 'backup-manifest.py'), 'capture', str(dump), '--database', spec.source_database], spec, env=manifest_env, cwd=ROOT)
    if not Path(str(dump) + '.manifest.json').is_file():
        raise RuntimeError('manifesto não foi gravado')
    write_checksum(dump)


def _verify_manifest(spec, dump, env):
    manifest_env = {
        'PATH': env['PATH'],
        'HOME': env.get('HOME', '/tmp'),
        'NEXO_DB_CONTAINER': spec.dest_container,
        'NEXO_DB_PORT': '5432',
    }
    _checked([sys.executable, str(ROOT / 'scripts' / 'backup-manifest.py'), 'verify', str(dump), '--database', spec.dest_database], spec, env=manifest_env, cwd=ROOT)


def _pg_restore(spec, container, database, dump):
    with Path(dump).open('rb') as handle:
        _checked(['docker', 'exec', '-i', container, 'pg_restore', '-p', '5432', '-U', 'nexo_owner', '-d', database, '--no-owner', '--exit-on-error'], spec, input_bytes=handle.read())


def _phase(phases, name):
    phases.append(name)
    print('fase: ' + name, flush=True)


def _run_scenario(spec, ambient, phases, refusals):
    assert_lab_identity(spec)
    _phase(phases, 'identidade')
    work = Path(spec.work_dir)
    bin_dir = ROOT / 'apps' / 'api-go' / 'bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    tool_env = toolchain_env(ambient)
    _checked(['go', 'build', '-o', str(bin_dir / 'nexo-db'), './cmd/nexo-db'], spec, env=tool_env, cwd=ROOT / 'apps' / 'api-go')
    _checked(['go', 'build', '-o', str(bin_dir / 'api'), './cmd/api'], spec, env=tool_env, cwd=ROOT / 'apps' / 'api-go')
    signing = subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-outform', 'DER'], capture_output=True, check=True).stdout
    spec.signing_key = base64.b64encode(signing).decode()
    assert_lab_identity(spec)
    source_env = process_env(spec, 'source', ambient)
    dest_env = process_env(spec, 'destination', ambient)
    if source_env['DATABASE_URL_OWNER'] == dest_env['DATABASE_URL_OWNER']:
        raise RestoreRefused('URLs de origem e destino coincidem')
    _create_volume(spec, spec.source_volume, 'source')
    _create_volume(spec, spec.dest_volume, 'destination')
    _create_container(spec, spec.source_container, spec.source_volume, spec.source_port, spec.source_owner_password, 'source')
    _create_container(spec, spec.dest_container, spec.dest_volume, spec.dest_port, spec.dest_owner_password, 'destination')
    _wait_db(spec.source_container)
    _wait_db(spec.dest_container)
    _psql(spec, spec.source_container, 'postgres', 'create database nexo_b12_source')
    cli = [str(bin_dir / 'nexo-db')]
    _checked(cli + ['prepare'], spec, env=source_env, cwd=ROOT)
    _checked(cli + ['seed-demo'], spec, env=source_env, cwd=ROOT)
    _roles_ok(spec, spec.source_container)
    _phase(phases, 'origem sintética')
    source_api = None
    source_log = None
    dest_api = None
    dest_log = None
    evidence = {}
    try:
        source_api, source_log, source_base = _api(source_env, spec, work / 'source-api.log')
        login = _call(source_base, '/api/auth/login', body={'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True})
        if login['status'] != 200 or not login['json'] or not login['json'].get('token'):
            raise RuntimeError('login sintético da origem recusado')
        token = login['json']['token']
        setup = _call(source_base, '/api/me/mfa/setup', token=token, body={})
        if setup['status'] != 200:
            raise RuntimeError('configuração MFA sintética recusada')
        plans = _call(source_base, '/api/plans', token=token)
        if plans['status'] != 200 or not isinstance(plans['json'], list):
            raise RuntimeError('planos sintéticos indisponíveis')
        plan = next(item['name'] for item in plans['json'] if item.get('active') is not False)
        marker = 'b12' + spec.run_id
        people = _call(source_base, '/api/import/apply', token=token, body={
            'kind': 'subscribers', 'source': marker, 'filename': marker + '.csv',
            'csv': 'id_externo;nome;situacao;plano;vencimento_dia\n' + marker + ';Assinante ' + marker + ';ativo;' + plan + ';10\n',
        })
        if people['status'] != 200 or people['json'].get('totals', {}).get('created') != 1:
            raise RuntimeError('importação sintética de assinante recusada')
        titles = _call(source_base, '/api/import/apply', token=token, body={
            'kind': 'invoices', 'source': marker, 'filename': marker + '-titulos.csv',
            'csv': 'id_externo;id_externo_assinante;vencimento;valor;situacao;pago_em;valor_pago\n'
                   + marker + '-full;' + marker + ';2026-11-20;100,00;pago;2020-05-01;\n',
        })
        if titles['status'] != 200 or titles['json'].get('totals', {}).get('created') != 1:
            raise RuntimeError('importação sintética de título recusada')
        batch_id = titles['json']['batch_id']
        invoice_id = next(row['entity_id'] for row in titles['json']['sample'] if row['external_id'] == marker + '-full')
        reason = 'motivo de compensacao do lote'
        idem = 'b12-comp-' + spec.run_id
        first = _call(source_base, '/api/import/batches/' + batch_id + '/compensate', token=token, body={'reason': reason}, headers={'Idempotency-Key': idem})
        if first['status'] != 200 or first['json'].get('idempotent_replay') is not False:
            raise RuntimeError('compensação sintética inicial recusada')
        compensation_id = first['json']['compensation_id']
        subscriber_id = _psql(spec, spec.source_container, spec.source_database, "select id::text from subscribers where external_source = '" + marker + "' and external_id = '" + marker + "'")
        contracts = _psql_json(spec, spec.source_container, spec.source_database, "select c.id::text as id from contracts c join tenants t on t.id = c.tenant_id where t.slug = 'alfa' order by c.id limit 2")
        if len(contracts) != 2 or not UUID_RE.match(subscriber_id):
            raise RuntimeError('massa sintética incompleta')
        pop_a = _call(source_base, '/api/pops', token=token, body={'name': 'POP alfa ' + marker, 'city': 'Cidade Demo', 'state': 'SP'})
        pop_b = _call(source_base, '/api/pops', token=token, body={'name': 'POP beta ' + marker, 'city': 'Cidade Demo', 'state': 'RJ'})
        if pop_a['status'] != 200 or pop_b['status'] != 200:
            raise RuntimeError('cadastro de POP sintético recusado')
        pop_a_id, pop_b_id = pop_a['json']['id'], pop_b['json']['id']
        contract_a, contract_b = contracts[0]['id'], contracts[1]['id']
        for contract, pop in ((contract_a, pop_a_id), (contract_b, pop_b_id)):
            assigned = _call(source_base, '/api/contracts/' + contract + '/pop', token=token, body={'pop_id': pop}, method='PUT')
            if assigned['status'] != 200:
                raise RuntimeError('vínculo de POP sintético recusado')
        attendant = _psql(spec, spec.source_container, spec.source_database, "select id::text from users where email = 'atendimento@alfa.demo'")
        scoped = _call(source_base, '/api/users/' + attendant + '/pops', token=token, body={'pop_ids': [pop_a_id]}, method='PUT')
        if scoped['status'] != 200:
            raise RuntimeError('escopo de POP do atendente recusado')
        payload = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n' + spec.run_id.encode()
        digest = hashlib.sha256(payload).hexdigest()
        uploaded = _call(source_base, '/api/subscribers/' + subscriber_id + '/documents', token=token, body={
            'kind': 'identity', 'name': 'comprovante-' + marker + '.pdf',
            'content_base64': base64.b64encode(payload).decode(),
        })
        if uploaded['status'] != 200:
            raise RuntimeError('upload sintético de documento recusado')
        document_id = uploaded['json']['id']
        portal_email = 'portal.' + spec.run_id + '@exemplo.demo'
        portal_password = 'portal-' + spec.run_id + '-sint'
        portal = _call(source_base, '/api/subscribers/' + subscriber_id + '/portal-access', token=token, body={'email': portal_email, 'password': portal_password})
        if portal['status'] != 200:
            raise RuntimeError('acesso de portal sintético recusado')
        spec.__dict__['portal_password'] = portal_password
        _stop_process(source_api)
        source_log.close()
        source_api, source_log = None, None
        _psql(spec, spec.source_container, spec.source_database, """
            insert into radius_account(tenant_id, username, secret_enc, policy, profile, applied_version)
            select id, 'b12-restore-proof', pgp_sym_encrypt('b12-radius-sintetica', '""" + spec.radius_key + """'), 'active', 'synthetic-profile', 1
            from tenants where slug = 'alfa'
        """)
        notice_id = _psql(spec, spec.source_container, spec.source_database, """
            insert into notice_log(tenant_id, status, message, contact_value, attempts)
            select id, 'queued', 'ensaio b12 fila sintetica sem transporte', '5500000000000', 0
            from tenants where slug = 'alfa'
            returning id::text
        """)
        river_row = _insert_river(spec, spec.source_container, spec.source_database)
        river_id, river_state = river_row.split()
        if river_state != 'available':
            raise RuntimeError('job sintético não ficou disponível')
        notice_before, river_before = _queue_state(spec, spec.source_container, spec.source_database, notice_id, river_id)
        reversals_before = _psql(spec, spec.source_container, spec.source_database, 'select count(*) from payments where invoice_id = ' + _qid(invoice_id) + " and kind = 'reversal'")
        markers_before = _psql(spec, spec.source_container, spec.source_database, 'select count(*) from import_batch_compensations where batch_id = ' + _qid(batch_id))
        dump = work / f'nexo-b12-{spec.run_id}.dump'
        _capture(spec, dump, source_env)
        require_checksum(dump)
        _phase(phases, 'backup manifesto e soma')
        _psql(spec, spec.source_container, spec.source_database, "insert into tenants(name, slug) values('Posterior " + marker + "', 'posterior-" + marker + "')")
        tampered_manifest = Path(str(dump) + '.manifest.json')
        original_manifest = tampered_manifest.read_text(encoding='utf-8')
        tampered_manifest.write_text(original_manifest + ' ', encoding='utf-8')
        try:
            restore_authenticated(spec, dump, lambda: (_ for _ in ()).throw(AssertionError('restore após manifesto inválido')))
        except RestoreRefused as exc:
            if 'soma' not in str(exc):
                raise
            note_outcome('checksum-manifesto', False)
            refusals.append('checksum-manifesto')
        else:
            note_outcome('checksum-manifesto', True)
        tampered_manifest.write_text(original_manifest, encoding='utf-8')
        write_checksum(dump)
        corrupt = work / f'nexo-b12-{spec.run_id}-corrupt.dump'
        blob = bytearray(dump.read_bytes())
        blob[-20] ^= 0x5A
        corrupt.write_bytes(blob)
        corrupt_manifest = Path(str(corrupt) + '.manifest.json')
        corrupt_manifest.write_text(original_manifest, encoding='utf-8')
        write_checksum(corrupt)
        bad_db = f'nexo_restore_check_{os.getpid()}_{100000 + secrets.randbelow(100000)}'
        _checked(cli + ['bootstrap', '--init-app-role'], spec, env=process_env(spec, 'destination', ambient, database='postgres'), cwd=ROOT)
        _roles_ok(spec, spec.dest_container)
        _phase(phases, 'bootstrap do destino')
        _psql(spec, spec.dest_container, 'postgres', 'create database ' + bad_db)
        corrupt_failed = False
        try:
            _pg_restore(spec, spec.dest_container, bad_db, corrupt)
        except RuntimeError:
            corrupt_failed = True
        finally:
            _psql(spec, spec.dest_container, 'postgres', 'drop database if exists ' + bad_db + ' with (force)')
        if not corrupt_failed:
            note_outcome('dump-manipulado', True)
        note_outcome('dump-manipulado', False)
        refusals.append('dump-manipulado')
        _phase(phases, 'manipulação recusada')
        _psql(spec, spec.dest_container, 'postgres', 'select 1 from pg_database where datname = ' + "'" + spec.dest_database + "'")
        if _psql(spec, spec.dest_container, 'postgres', "select count(*) from pg_database where datname = '" + spec.dest_database + "'") != '0':
            raise RestoreRefused('destino já continha o banco de restore')
        _psql(spec, spec.dest_container, 'postgres', 'create database ' + spec.dest_database)
        restore_authenticated(spec, dump, lambda: _pg_restore(spec, spec.dest_container, spec.dest_database, dump))
        _phase(phases, 'restore no cluster vazio')
        _verify_manifest(spec, dump, dest_env)
        _phase(phases, 'manifesto conferido')
        isolation = (ROOT / 'scripts' / 'restore-isolation.sql').read_bytes()
        _checked(['docker', 'exec', '-i', spec.dest_container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-p', '5432', '-U', 'nexo_owner', '-d', spec.dest_database], spec, input_bytes=isolation)
        _roles_ok(spec, spec.dest_container)
        _ownership_ok(spec, spec.dest_container, spec.dest_database)
        if not UUID_RE.match(pop_a_id) or not UUID_RE.match(pop_b_id):
            raise RestoreRefused('POP inesperado')
        leaked = _psql(spec, spec.dest_container, spec.dest_database, """
            begin;
            select set_config('app.tenant_id', (select id::text from tenants where slug = 'alfa'), true);
            select set_config('app.pop_ids', '""" + pop_a_id + """', true);
            select set_config('app.is_operator', 'off', true);
            set local role nexo_go;
            select count(*) from contracts where pop_id = '""" + pop_b_id + """'::uuid;
            rollback;
        """)
        counts = [line for line in leaked.splitlines() if re.fullmatch(r'\d+', line)]
        if not counts or counts[-1] != '0':
            raise RuntimeError('POP enxergou contrato de outro POP')
        _phase(phases, 'isolamento e grants')
        stored = _psql(spec, spec.dest_container, spec.dest_database, 'select encode(content, \'hex\') || \' \' || sha256 || \' \' || size_bytes::text from documents where id = ' + _qid(document_id))
        hex_content, stored_hash, stored_size = stored.split()
        if bytes.fromhex(hex_content) != payload or stored_hash != digest or int(stored_size) != len(payload):
            raise RuntimeError('documento restaurado diverge em bytes ou sha256')
        _phase(phases, 'documentos por bytes')
        verify_env = dict(dest_env)
        verify_env['NEXO_RESTORE_DATABASE'] = spec.dest_database
        verified = subprocess.run(cli + ['verify-restore'], cwd=ROOT, env=verify_env, capture_output=True)
        if verified.returncode != 0:
            raise RuntimeError('verify-restore com a chave explícita recusou o destino')
        if b'omitido' in verified.stdout or spec.aes_key.encode() in verified.stdout + verified.stderr:
            raise RuntimeError('verify-restore revelou material')
        _phase(phases, 'verify-restore')
        wrong_aes = dict(verify_env)
        wrong_aes['NEXO_SECRET_KEY'] = base64.b64encode(secrets.token_bytes(32)).decode()
        rejected = subprocess.run(cli + ['verify-restore'], cwd=ROOT, env=wrong_aes, capture_output=True)
        rejected_text = rejected.stderr + rejected.stdout
        if rejected.returncode == 0 or 'chave incompat'.encode() not in rejected_text:
            raise RuntimeError('chave AES errada não foi recusada')
        if wrong_aes['NEXO_SECRET_KEY'].encode() in rejected_text or spec.aes_key.encode() in rejected_text or b'b12-radius-sintetica' in rejected_text:
            raise RuntimeError('recusa de chave revelou material')
        wrong_radius = dict(verify_env)
        wrong_radius['NEXO_RADIUS_KEY'] = 'chave-radius-sintetica-b12-errada-' + spec.run_id
        rejected = subprocess.run(cli + ['verify-restore'], cwd=ROOT, env=wrong_radius, capture_output=True)
        rejected_text = rejected.stderr + rejected.stdout
        if rejected.returncode == 0 or 'chave RADIUS incompat'.encode() not in rejected_text:
            raise RuntimeError('chave RADIUS errada não foi recusada')
        if wrong_radius['NEXO_RADIUS_KEY'].encode() in rejected_text or b'b12-radius-sintetica' in rejected_text:
            raise RuntimeError('recusa RADIUS revelou material')
        _phase(phases, 'chave errada recusada')
        if _psql(spec, spec.dest_container, spec.dest_database, "select count(*) from tenants where slug = 'posterior-" + marker + "'") != '0':
            raise RuntimeError('escrita posterior ao snapshot entrou no destino')
        notice_after, river_after = _queue_state(spec, spec.dest_container, spec.dest_database, notice_id, river_id)
        if (notice_after, river_after) != (notice_before, river_before) or notice_after != 'queued' or not river_after.startswith('available'):
            raise RuntimeError('fila restaurada não preservou o estado')
        _phase(phases, 'fila persistida sem execução')
        dest_api, dest_log, dest_base = _api(dest_env, spec, work / 'dest-api.log')
        restored_login = _call(dest_base, '/api/auth/login', body={'email': 'admin@alfa.demo', 'password': 'demo1234', 'bearer': True})
        if restored_login['status'] != 200:
            raise RuntimeError('login no destino restaurado recusado')
        restored_token = restored_login['json']['token']
        me = _call(dest_base, '/api/me', token=restored_token)
        if me['status'] != 200 or me['json'].get('email') != 'admin@alfa.demo':
            raise RuntimeError('sessão do destino não é a do admin sintético')
        _phase(phases, 'login e sessão')
        download = _call(dest_base, '/api/documents/' + document_id + '/download', token=restored_token)
        if download['status'] != 200 or download['body'] != payload:
            raise RuntimeError('download autorizado diverge dos bytes')
        if download['headers'].get('content-type', '').split(';')[0] != 'application/pdf':
            raise RuntimeError('download autorizado sem o tipo do documento')
        beta = _call(dest_base, '/api/auth/login', body={'email': 'admin@beta.demo', 'password': 'demo1234', 'bearer': True})
        if beta['status'] != 200:
            raise RuntimeError('login do outro tenant sintético recusado')
        denied = _call(dest_base, '/api/documents/' + document_id + '/download', token=beta['json']['token'])
        if denied['status'] == 200 or denied['body'] == payload:
            raise RuntimeError('outro tenant baixou o documento')
        _phase(phases, 'download HTTP e recusa entre tenants')
        portal_login = _call(dest_base, '/api/auth/login', body={'email': portal_email, 'password': portal_password, 'bearer': True})
        if portal_login['status'] != 200:
            raise RuntimeError('login de portal sintético recusado')
        portal_denied = _call(dest_base, '/api/documents/' + document_id + '/download', token=portal_login['json']['token'])
        if portal_denied['status'] == 200:
            raise RuntimeError('portal baixou documento')
        attendant_login = _call(dest_base, '/api/auth/login', body={'email': 'atendimento@alfa.demo', 'password': 'demo1234', 'bearer': True})
        if attendant_login['status'] != 200:
            raise RuntimeError('login do atendente sintético recusado')
        attendant_token = attendant_login['json']['token']
        seen = _call(dest_base, '/api/contracts/' + contract_a, token=attendant_token)
        hidden = _call(dest_base, '/api/contracts/' + contract_b, token=attendant_token)
        if seen['status'] != 200 or hidden['status'] == 200:
            raise RuntimeError('escopo de POP não isolou os contratos na API')
        _phase(phases, 'portal e POP')
        _stop_process(dest_api)
        dest_log.close()
        dest_api, dest_log = None, None
        notice_mid, river_mid = _queue_state(spec, spec.dest_container, spec.dest_database, notice_id, river_id)
        dest_api, dest_log, dest_base = _api(dest_env, spec, work / 'dest-api-restart.log')
        notice_resumed, river_resumed = _queue_state(spec, spec.dest_container, spec.dest_database, notice_id, river_id)
        if (notice_mid, river_mid) != (notice_resumed, river_resumed) or not river_resumed.startswith('available'):
            raise RuntimeError('retomada com jobs desligados alterou a fila')
        _phase(phases, 'retomada com jobs desligados')
        replay = _call(dest_base, '/api/import/batches/' + batch_id + '/compensate', token=restored_token, body={'reason': reason}, headers={'Idempotency-Key': idem})
        if replay['status'] != 200 or replay['json'].get('idempotent_replay') is not True or replay['json'].get('compensation_id') != compensation_id:
            raise RuntimeError('replay da compensação não devolveu o mesmo marcador')
        if replay['json'].get('reversed_payments') != first['json'].get('reversed_payments'):
            raise RuntimeError('replay alterou o resultado persistido')
        reversals_after = _psql(spec, spec.dest_container, spec.dest_database, 'select count(*) from payments where invoice_id = ' + _qid(invoice_id) + " and kind = 'reversal'")
        markers_after = _psql(spec, spec.dest_container, spec.dest_database, 'select count(*) from import_batch_compensations where batch_id = ' + _qid(batch_id))
        if reversals_after != reversals_before or markers_after != markers_before or markers_after != '1':
            raise RuntimeError('replay criou nova reversão ou outro marcador')
        eligibility = _call(dest_base, '/api/import/batches/' + batch_id + '/revert-eligibility', token=restored_token)
        compensation = (eligibility.get('json') or {}).get('compensation') or {}
        if eligibility['status'] != 200 or compensation.get('state') != 'committed' or compensation.get('compensation_id') != compensation_id:
            raise RuntimeError('leitura da compensação restaurada divergiu')
        if 'idempotency_key' in json.dumps(replay['json']) or 'request_hash' in json.dumps(replay['json']):
            raise RuntimeError('replay revelou a chave de idempotência')
        _phase(phases, 'replay da compensação B13')
        evidence = {'document_sha256': digest, 'compensation_id': compensation_id, 'queue': 'notice_log queued e river available'}
    finally:
        _stop_process(source_api)
        _stop_process(dest_api)
        if source_log:
            source_log.close()
        if dest_log:
            dest_log.close()
    if not allow_success(phases, refusals):
        raise RuntimeError('fases ou recusas incompletas')
    return phases, refusals, evidence


def _report(ok, phases, refusals, spec, error=None):
    payload = {
        'ok': ok,
        'criterion': 'B12',
        'base': _git_head(),
        'phases': phases,
        'refusals': refusals,
        'limits': LIMITS,
        'static_approval': False,
        'secrets': 'omitidos',
        'resources': None if spec is None else {
            'source_container': spec.source_container,
            'destination_container': spec.dest_container,
            'source_volume': spec.source_volume,
            'destination_volume': spec.dest_volume,
            'source_port': spec.source_port,
            'destination_port': spec.dest_port,
            'image': spec.image,
            'label': 'nexo.lab=' + LAB_LABEL,
            'run': spec.run_id,
        },
    }
    if error:
        payload['error'] = error
    _write_report(payload)
    print(json.dumps({
        'ok': ok,
        'criterion': 'B12',
        'base': payload['base'],
        'phases': phases,
        'limits': LIMITS,
        'secrets': 'omitidos',
    }, ensure_ascii=False), flush=True)
    return payload


def main():
    spec = None
    phases = []
    refusals = []
    try:
        spec = new_spec()
        assert_lab_identity(spec)
        require_runtime()
        work = tempfile.TemporaryDirectory(prefix=f'nexo-b12-{spec.run_id}-')
        spec.work_dir = work.name
        assert_lab_identity(spec)
        try:
            _run_scenario(spec, dict(os.environ), phases, refusals)
            _report(True, phases, refusals, spec)
        finally:
            try:
                cleanup(spec)
            finally:
                work.cleanup()
    except SystemExit:
        raise
    except Exception as exc:
        message = redact(str(exc), spec.secrets() if spec else [])
        _report(False, phases, refusals, spec, error=type(exc).__name__ + ': ' + message[:500])
        raise


if __name__ == '__main__':
    main()
