# NexoISP

ERP SaaS para provedores de internet. Consulte o [índice da documentação](docs/README.md), a
[arquitetura atual](docs/arquitetura.md) e as [pendências para produção](docs/pendencias.md).

A interface oficial usa o frontend do v0, com as sete etapas de integração concluídas. A [matriz funcional](docs/integracao-v0/MATRIZ_FUNCIONAL.md) registra 139 unidades integradas e validadas e 30 capacidades internas/limitações do Go preservadas. Recursos somente previstos no desenho são identificados como planejados. O [plano e a validação](docs/integracao-v0/PLANO.md) documentam o fechamento; [execução e limites](docs/integracao-v0/OPERACAO.md) explicam a aplicação oficial e os laboratórios. A referência original e o frontend anterior foram preservados.

Desenvolvimento do novo frontend: `npm ci` e `API_URL=http://127.0.0.1:18081 npm -w apps/web run dev`. O endereço de `API_URL` deve apontar para o Go do seu ambiente. A aplicação abre em http://127.0.0.1:3000; a demonstração visual independente está em http://127.0.0.1:3000/demonstracao/.

## Rodar localmente (demonstração)

Requisitos: Docker + Docker Compose, `openssl`. API, rotinas, VPN e ferramentas administrativas usam Go. O frontend React usa Node somente no build; o agente de rede permanece Python.

```bash
./nexo up          # gera segredos/certificados de desenvolvimento, sobe banco, API+web e o agente de demonstração
```

Abrir http://localhost:18080 — contas de demonstração na tela de login (senha `demo1234`).

```bash
./nexo test        # testes Go
./nexo contrato nativo # instalação e fluxos críticos com duas réplicas Go, banco sintético
./nexo agent-test  # regressões do agente (confirmação perdida, reinício, reentrega)
./nexo lab-radius  # prova com FreeRADIUS real (sem NAS)
./nexo lab-up      # laboratório PPPoE real: MikroTik CHR 7.24.5 em KVM + cliente pppd (ver docs/lab-pppoe.md)
./nexo lab cgnat   # com o laboratório no ar: aplica o CGNAT gerado no CHR, confere as traduções e remove
./nexo typecheck   # análise Go e tipos do frontend
cd e2e && npm i && npx playwright install chromium && BASE=http://localhost:18080 npm run smoke   # usar exclusivamente laboratório descartável com dados sintéticos
./nexo backup      # backup do banco;  ./nexo restore-check <arquivo>
./nexo logs api    # logs;  ./nexo down para parar
```

## Estrutura

```
apps/api-go             Backend Go: API, identidade, rede, financeiro, importação, IPAM, campo, CRM, NOC, River, VPN e CLI
db/migrations           Migrations goose (fonte única do schema)
apps/web                Frontend oficial v0: React + Vite, integrado ao Go existente
apps/web-legacy         Frontend anterior preservado para consulta de comportamentos
services/network-agent  Agente Python (SQLite, drivers demo e mikrotik_radius)
infra/compose           Ambiente local      infra/site  Agente + RADIUS no provedor      infra/prod  Instalação central
e2e                     Teste de fumaça da interface em navegador (Playwright)
.github/workflows       Integração contínua: tipos, build, auditoria, testes da API e do agente, fumaça da interface
scripts                 Certificados dev, backup/restauração, pacote assinado do agente, laboratório RADIUS
samples                 CSVs sintéticos do importador
```

Produção: `./nexo prod up`, após configurar `infra/prod/.env` e os certificados. Administração: `./nexo prod db create-operator <email> <nome>` (senha em `NEXO_NEW_PASSWORD`), `./nexo prod db preflight` e `./nexo prod db rotate-secrets`. Consulte a [operação](docs/operacao.md) para implantação e recuperação.

Configuração dos módulos: [operação](docs/operacao.md). Driver e homologação de OLT/ONU: [guia OLT](docs/expansao-olt-onu.md).
Bloqueios do lançamento e evolução ainda necessária: [pendências](docs/pendencias.md).

Simulado x real: os drivers `demo` e `olt_demo` e o gateway `demo` são simulações identificadas na interface e bloqueadas fora do modo
demonstração. A integração MikroTik/PPPoE foi validada em laboratório virtual (CHR 7.24.5), não no equipamento do piloto, e não há gateway de pagamento real integrado.
