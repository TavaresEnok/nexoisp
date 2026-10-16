#!/usr/bin/env python3
import json, sys, collections
r = json.load(open(sys.argv[1]))

# rota de template no mapa.ts: duas rotas reais
out = []
for x in r:
    if x['path'] == '/api/${table}/:id/location':
        for tb, perm in (('contracts', 'contracts:write'), ('pops', 'network:write')):
            y = dict(x); y['path'] = f'/api/{tb}/:id/location'; y['perm'] = perm; y['tables'] = sorted({tb, 'audit_events'}); out.append(y)
    elif x['path'] == '/api/contracts/:id/cpe/${path}':
        for sub in ('reboot', 'refresh'):
            y = dict(x); y['path'] = f'/api/contracts/:id/cpe/{sub}'; out.append(y)
    else:
        if x['path'] == '/api/support/exit': x['perm'] = '(sessão; só saas_operator)'
        out.append(x)
r = out

F1 = {('GET', '/api/subscribers/:id'), ('GET', '/api/contracts/:id'), ('GET', '/api/subscribers')}
F2_FILES = {'cadastro.ts', 'portal.ts'}
F5_FILES = {'identity.ts', 'import.ts', 'network.ts', 'olt.ts', 'radius.ts', 'tr069.ts', 'public-api.ts'}

def phase(x):
    m, p, f = x['method'], x['path'], x['file']
    if (m, p) in F1: return 1
    if p == '/api/health': return 8
    if f == 'agent-api.ts': return 7
    if m == 'GET':
        if x['helper_w'] or x['ext'] or f == 'public-api.ts': return 5
        if f in F2_FILES or x['perm'] == 'portal:self' or p in ('/api/me', '/api/plans', '/api/plans/:id'): return 2
        return 3
    if p.startswith('/api/webhooks/gateway') or x['fin']: return 6
    if f in F5_FILES or x['net'] or x['ext'] or x['cx'] == 'A': return 5
    return 4

KIND = {'L': 'leitura', 'L+aud': 'leitura + auditoria', 'E': 'escrita'}
for x in r:
    x['phase'] = phase(x)
    obs = []
    if x['csv']: obs.append('`?format=csv` + auditoria')
    if x['method'] == 'GET' and x['helper_w']: obs.append('**GET com escrita lateral**')
    if x['net']: obs.append('operação de rede (fila)')
    if x['ext']: obs.append('E/S externa')
    if x['fin']: obs.append('toca financeiro')
    x['obs'] = '; '.join(obs)

def md_tables(t):
    t = [y for y in t if y != 'audit_events'] + (['audit_events'] if 'audit_events' in t else [])
    return ', '.join(f'`{y}`' for y in t) if t else '—'

by_file = collections.OrderedDict()
for x in r: by_file.setdefault(x['file'], []).append(x)

P = lambda *a: print(*a)
P('# Inventário de rotas do Fastify')
P()
P('Gerado a partir do código em `legacy/fastify/src/routes/*.ts`, `app.ts` e `agent-api.ts` (commit de trabalho de 16/10/2026) e revisado à mão nos pontos marcados.')
P('A extração é estática: lê cada declaração `app.get/post/put/patch/delete`, o `guard(...)` da rota, o SQL do corpo do handler e o SQL das funções')
P('auxiliares chamadas (até dois níveis) e das constantes SQL compartilhadas (`CONTRACT_SELECT`, `LEAD_SELECT` etc.).')
P()
P('**Limites da extração (ler antes de usar a tabela):**')
P()
P('- "Tabelas" é uma aproximação por cima: inclui tabelas de funções auxiliares que podem não ser tocadas em todos os caminhos da rota. Rotas com `—` montam a resposta sem SQL direto (configuração, cálculo ou chamada a serviço externo) ou usam funções `security definer`.')
P('- O módulo vem das mesmas expressões regulares de `MODULE_ROUTES` em `auth.ts`. Rotas sem módulo pertencem ao núcleo (sempre liberado).')
P('- "Complexidade" (B/M/A) é heurística: tamanho do handler, número de tabelas, escrita, financeiro, operação de rede, E/S externa e `for update`. Serve para ordenar o trabalho, não para estimar prazo.')
P('- Antes de migrar cada rota, o responsável confirma a linha correspondente lendo o handler. Divergências encontradas devem corrigir esta tabela no mesmo PR.')
P()
P('Legenda — **Tipo**: leitura, leitura + auditoria (grava em `audit_events`) ou escrita. **Cx**: B baixa, M média, A alta. **Fase**: ver `PLANO.md` (1 = piloto, 2 = leituras de maior tráfego, 3 = demais leituras, 4 = escritas simples, 5 = escritas complexas / identidade / rede / API pública, 6 = financeiro, 7 = API de agentes, 8 = permanece no Fastify até o desligamento).')
P()

# resumo
tot = collections.Counter(x['phase'] for x in r)
kinds = collections.Counter(x['kind'] for x in r)
cx = collections.Counter(x['cx'] for x in r)
methods = collections.Counter(x['method'] for x in r)
P('## Resumo')
P()
P(f'- **{len(r)} rotas** HTTP: ' + ', '.join(f'{k} {v}' for k, v in sorted(methods.items())) + '.')
P(f'- Por tipo: leitura {kinds["L"]}, leitura + auditoria {kinds["L+aud"]}, escrita {kinds["E"]}.')
P(f'- Por complexidade: B {cx["B"]}, M {cx["M"]}, A {cx["A"]}.')
P('- Por fase sugerida: ' + ', '.join(f'F{k}: {v}' for k, v in sorted(tot.items())) + '.')
side = [x for x in r if x['method'] == 'GET' and x['helper_w']]
P(f'- **{len(side)} GETs com escrita lateral** (ex.: `sweep()` que expira operações vencidas, contador de uso da API pública, auditoria de relatório). Eles não podem ser tratados como leitura pura: o Go precisa reproduzir o efeito, e o teste de contrato compara também o estado do banco depois da chamada.')
P()
P('| Arquivo | Rotas | Leitura | Escrita | A | Fase predominante |')
P('|---|---:|---:|---:|---:|---|')
for f, xs in by_file.items():
    ph = collections.Counter(x['phase'] for x in xs).most_common(1)[0][0]
    P(f'| `{f}` | {len(xs)} | {sum(1 for x in xs if x["kind"] != "E")} | {sum(1 for x in xs if x["kind"] == "E")} | {sum(1 for x in xs if x["cx"] == "A")} | F{ph} |')
P()
P('## Rotas e caminhos fora de `/api/*`')
P()
P('O proxy precisa conhecer estes prefixos além de `/api/*` (ver `ARQUITETURA.md`, seção do proxy):')
P()
P('- `/aviso/:slug` — página HTML pública de aviso, com CSP própria.')
P('- `/public/v1/*` — API pública por token (escopos e limite por token gravado no banco, tabela `api_rate`).')
P('- `/agent/v1/*` — API dos agentes, **em outra porta (8443) com mTLS direto na API**, fora do Caddy. Não passa pelo proxy do painel.')
P('- `/api/webhooks/gateway/:gateway` — entrada de pagamentos do gateway (assinatura HMAC, sem sessão). É financeiro: fase 6.')
P('- Exportação CSV: as listas `subscribers`, `contracts`, `invoices`, `work-orders`, `tickets`, `leads`, `stock/items`, `stock/units` e `audit` aceitam `?format=csv` por um hook `onSend` global (`csv.ts`), que também audita `export.csv`. Quem migrar uma dessas listas migra junto o CSV.')
P()

for f, xs in by_file.items():
    P(f'## `{f}`')
    P()
    P('| Método | Rota | Permissão | Módulo | Tabelas | Tipo | Cx | Fase | Observações |')
    P('|---|---|---|---|---|---|---|---|---|')
    for x in xs:
        P(f'| {x["method"]} | `{x["path"]}` | {("`"+x["perm"]+"`") if x["perm"] and not x["perm"].startswith("(") else (x["perm"] or "—")} | {x["module"] or "núcleo"} | {md_tables(x["tables"])} | {KIND[x["kind"]]} | {x["cx"]} | F{x["phase"]} | {x["obs"]} |')
    P()

P('## Acoplamentos que a tabela não mostra')
P()
P('Estes efeitos atravessam rotas e precisam ser portados junto com a primeira rota que os dispara (e testados no contrato pelo estado do banco):')
P()
P('- **`contractChangeHooks`** (`hooks.ts`): `changeContract()` executa, na mesma transação, ganchos registrados por `network.ts` e `olt.ts`. Trocar plano, vencimento ou encerrar contrato pode **gerar operação de rede** (`operations`) e mudar ONU, mesmo em rotas de `cadastro.ts`. Também é usado pelas mudanças agendadas (`scheduled.ts`).')
P('- **`emitEvent()`** (`webhooks.ts`): grava em `webhook_deliveries` (saída de webhooks) na transação da rota, se o provedor tem o módulo `api` e um endpoint inscrito no evento. Funciona como uma fila de saída: a entrega é feita depois, pela rotina periódica.')
P('- **`queueNotice()`** (`notify.ts`): grava em `notifications` para envio posterior.')
P('- **`audit()`** (`auth.ts`): grava em `audit_events` na transação da rota, ou em transação própria quando chamada fora dela (ex.: negativa de permissão no `guard`, que também é auditada).')
P('- **`sweep()`** (`network/engine.ts`): expira operações e tentativas vencidas; é chamada por leituras (`GET /api/operations`, `GET /api/noc/overview` e outras) e pela reserva do executor.')
P('- **`nextNumber()`** (`db.ts`): contador por provedor em `tenant_counters` (número de OS e protocolo), dentro da transação.')
P()
P('## Rotinas sem rota HTTP (não são roteadas pelo proxy)')
P()
P('Rodam dentro do processo da API Fastify hoje e só mudam de lugar na fase 7 (River). Até lá continuam no Node.')
P()
P('| Rotina | Arquivo | Frequência atual | Trava | Escreve em |')
P('|---|---|---|---|---|')
P('| Rotina periódica (cobrança automática, reconciliação, alertas de plataforma, entrega de avisos e webhooks, limpeza de throttle) | `worker.ts`, `finance/core.ts`, `notify.ts`, `webhooks.ts` | 60 s | `pg_try_advisory_lock(7411002)` | `invoices`, `payments`, `notifications`, `webhook_deliveries`, `login_throttle` e outras |')
P('| Executor do RADIUS integrado (fila de operações → `radius_*` + desconexão CoA) | `radius/executor.ts`, `network/engine.ts` | 2 s (contabilização a cada ~14 s) | `for update ... skip locked` na reserva | `operations`, `operation_attempts`, `radius_account`, `radius_check`, `radius_reply`, `service_sessions`, `usage_*` |')
P('| Mudanças de contrato agendadas | `scheduled.ts` | chamada pela rotina periódica | transação por mudança | `scheduled_changes`, `contracts`, `contract_history`, `invoices` |')
P('| SLA de chamados e OS | `sla.ts` | chamada pela rotina periódica | — | `tickets`, `work_orders` |')
P('| Avisos ao assinante | `notices.ts` | chamada pela rotina periódica | — | `notice_log` |')
P('| Serviço de túnel (WireGuard/L2TP) | `vpn.ts` | processo próprio (serviço `vpn`) | — | `vpn_peers`, `l2tp_peers` — **mantido em Node** (fora do escopo) |')
