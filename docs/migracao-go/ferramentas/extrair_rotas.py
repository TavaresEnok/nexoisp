#!/usr/bin/env python3
"""Extrai o inventario de rotas do Fastify (legacy/fastify/src/routes + app.ts + agent-api.ts) para JSON."""
import json, re, sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
SRC = ROOT / 'legacy/fastify/src'
MIG = ROOT / 'legacy/fastify/migrations'

tables = set()
for f in sorted(MIG.glob('*.sql')):
    for m in re.finditer(r'create (?:unlogged )?table (?:if not exists )?([a-z_][a-z0-9_]*)', f.read_text(), re.I):
        tables.add(m.group(1).lower())

MODULE_ROUTES = [
    ('olt', r'^/api/(olt/|onus(/|$)|contracts/[^/]+/onu$)'),
    ('ipam', r'^/api/(ipam/|cgnat/|contracts/[^/]+/(ips|ipv6)$)'),
    ('field', r'^/api/(work-orders(/|$)|stock/|contracts/[^/]+/equipment$|agenda(/|$)|surveys(/|$)|portal/surveys(/|$)|install-kits(/|$))'),
    ('crm|field', r'^/api/(sla-policies(/|$)|reports/sla$)'),
    ('ftth', r'^/api/(ftth/|contracts/[^/]+/ftth$)'),
    ('crm', r'^/api/(leads(/|$)|tickets(/|$)|crm/|portal/tickets(/|$))'),
    ('noc', r'^/api/(noc/|contracts/[^/]+/diagnosis$)'),
    ('notices', r'^/api/notifications(/|$)'),
    ('messages', r'^/api/(notice-(channels|templates|rules|log)(/|$))'),
    ('api', r'^/api/(api-tokens|webhook-endpoints|webhook-deliveries|integrations)(/|$)'),
]
def module_of(path):
    p = re.sub(r':[A-Za-z_]+', 'x', path)
    for mod, rx in MODULE_ROUTES:
        if re.search(rx, p):
            return mod
    return ''

EXPORTABLE = re.compile(r'^/api/(subscribers|contracts|invoices|work-orders|tickets|leads|stock/items|stock/units|audit)$')
ROUTE_RX = re.compile(r"\bapp\.(get|post|put|patch|delete)\(\s*(['`\"])(.*?)\2\s*,", re.M | re.S)
WRITE_SQL = re.compile(r'\b(insert\s+into|update\s+[a-z_]+\s+set|delete\s+from|on\s+conflict)\b', re.I)
TABLE_SQL = re.compile(r'\b(?:from|join|into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)', re.I)
EXTERNAL = re.compile(r'\b(fetch\(|sendDisconnect|acs\.|findDevices|getDevice|task\(|sendMessage|sendTestNotice|sendTestEvent|assertSafeWebhookUrl)')

def functions_in(text):
    """nome -> corpo das funcoes de nivel superior (aproximado)"""
    out = {}
    for m in re.finditer(r'^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(', text, re.M):
        start = m.start()
        nxt = re.search(r'^(?:export )?(?:async )?function |^export const |^const |^export async function ', text[m.end():], re.M)
        end = m.end() + nxt.start() if nxt else len(text)
        out[m.group(1)] = text[start:end]
    return out

# helpers que tocam o banco, em todo o src (para atribuir tabelas indiretas)
helpers = {}
for f in SRC.rglob('*.ts'):
    for name, body in functions_in(f.read_text()).items():
        helpers.setdefault(name, body)

consts = {}
for f in SRC.rglob('*.ts'):
    for m in re.finditer(r'^\s*(?:export )?const ([A-Z_][A-Z0-9_]*) = `(.*?)`', f.read_text(), re.M | re.S):
        consts.setdefault(m.group(1), m.group(2))
SQLFN = {'session_': ['sessions', 'users'], 'login_throttle': ['login_throttle'], 'platform_health': ['agents', 'operations']}
def tables_of(text):
    t = {x.lower() for x in TABLE_SQL.findall(text) if x.lower() in tables}
    for name, sql in consts.items():
        if re.search(r'\b' + name + r'\b', text):
            t |= {x.lower() for x in TABLE_SQL.findall(sql) if x.lower() in tables}
    for pre, tb in SQLFN.items():
        if re.search(r'\b' + pre, text):
            t |= {x for x in tb if x in tables}
    return t

SKIP = {'guard', 'withScope', 'paged', 'get', 'post', 'put', 'patch', 'delete', 'call', 'parse', 'query', 'register'}
def analyse(body, depth=0, seen=None, allowed=None):
    seen = seen or set()
    tb = tables_of(body)
    w = bool(WRITE_SQL.search(body))
    ext = bool(EXTERNAL.search(body))
    if depth < 2:
        for call in set(re.findall(r'\b([A-Za-z_][A-Za-z0-9_]*)\(', body)):
            if call in helpers and call not in seen and call not in SKIP and (allowed is None or call in allowed):
                seen.add(call)
                t2, w2, e2 = analyse(helpers[call], depth + 1, seen)
                tb |= t2; w |= w2; ext |= e2
    if re.search(r'\baudit\(', body):
        tb.add('audit_events')
    return tb, w, ext

def perm_of(opts):
    m = re.search(r"guard\(\s*'([^']+)'", opts)
    if m: return m.group(1)
    if re.search(r'guard\(\s*undefined', opts) or re.search(r'\bself\b', opts): return '(sessão, MFA pendente aceito)'
    m = re.search(r"guardApi\(\s*'([^']+)'", opts)
    if m: return f'token API: {m.group(1)}'
    return ''

routes = []
files = sorted((SRC / 'routes').glob('*.ts')) + [SRC / 'app.ts', SRC / 'agent-api.ts']
for f in files:
    text = f.read_text()
    allowed = set(re.findall(r'\b([A-Za-z_][A-Za-z0-9_]*)\b', ' '.join(re.findall(r'^import \{([^}]*)\}', text, re.M)))) | set(functions_in(text))
    ms = list(ROUTE_RX.finditer(text))
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        body = text[m.start():end]
        head = body[:400]
        method, path = m.group(1).upper(), m.group(3)
        perm = perm_of(head)
        if not perm:
            if path.startswith('/agent/'): perm = 'mTLS do agente'
            elif path.startswith('/public/'): perm = 'token API (escopo)' if 'guardApi' in body[:800] else 'pública'
            elif path in ('/api/auth/login', '/api/health') or path.startswith('/aviso/') or path.startswith('/api/webhooks/'): perm = 'pública'
        tb, w, ext = analyse(body, allowed=allowed)
        lines = body.count('\n')
        direct_w = bool(WRITE_SQL.search(body))
        helper_w = w and not direct_w
        if method == 'GET':
            kind = 'E' if direct_w else ('L+aud' if re.search(r'\baudit\(', body) else 'L')
            w = direct_w
        else:
            w = w or bool(tb - {'audit_events'})
            kind = 'E' if w else 'L'
        fin = bool(tb & {'invoices', 'invoice_items', 'payments', 'agreements', 'gateway_events', 'demo_gateway_charges', 'trust_releases'})
        net = bool(re.search(r'requestOperation|executeOne|onuOperation|operations\b|changeContract|contractChangeHooks', body))
        score = (2 if lines > 80 else 1 if lines > 30 else 0) + (1 if len(tb) > 5 else 0) + (2 if w else 0) + (2 if fin and w else 0) + (2 if net and w else 0) + (2 if ext else 0) + (1 if 'for update' in body else 0)
        cx = 'A' if score >= 5 else 'M' if score >= 2 else 'B'
        routes.append(dict(file=f.name, method=method, path=path, perm=perm, module=module_of(path),
                           tables=sorted(tb), kind=kind, cx=cx, lines=lines, fin=fin, net=net and w, ext=ext,
                           helper_w=helper_w, csv=bool(method == 'GET' and EXPORTABLE.match(re.sub(r':[A-Za-z_]+', 'x', path)))))
expanded=[]
templates={
 '/api/${table}/:id/location':[('/api/contracts/:id/location','contracts:write'),('/api/pops/:id/location','network:write')],
 '/api/contracts/:id/cpe/${path}':[('/api/contracts/:id/cpe/reboot','network:operate'),('/api/contracts/:id/cpe/refresh','network:operate')],
 "/api/${entity === 'subscriber' ? 'subscribers' : 'contracts'}/:id/custom":[('/api/subscribers/:id/custom','subscribers:write'),('/api/contracts/:id/custom','contracts:write')],
}
for route in routes:
    if '${' in route['path']:
        if route['path'] not in templates:raise ValueError('template de rota exige expansão explícita: '+route['path'])
        for path,perm in templates[route['path']]:expanded.append(dict(route,path=path,perm=perm,module=module_of(path)))
    else:expanded.append(route)
json.dump(expanded, sys.stdout, ensure_ascii=False, indent=1)
