# NexoISP

ERP SaaS para provedores de internet (MVP). Documentos em `docs/`; estado atual e pendências na seção **Progresso** de
`docs/04-etapas-e-prompts-de-desenvolvimento.md`.

## Rodar localmente (demonstração)

Requisitos: Docker + Docker Compose, `openssl`. Node/Python/PostgreSQL rodam em containers.

```bash
./nexo up          # gera segredos/certificados de desenvolvimento, sobe banco, API+web e o agente de demonstração
```

Abrir http://localhost:18080 — contas de demonstração na tela de login (senha `demo1234`).

```bash
./nexo test        # regressões da API (isolamento, financeiro, operações, importação/portal, MFA, sessão)
./nexo agent-test  # regressões do agente (confirmação perdida, reinício, reentrega)
./nexo lab-radius  # prova com FreeRADIUS real (sem NAS)
./nexo lab-up      # laboratório PPPoE real: MikroTik CHR 7.24.5 em KVM + cliente pppd (ver docs/lab-pppoe.md)
./nexo lab cgnat   # com o laboratório no ar: aplica o CGNAT gerado no CHR, confere as traduções e remove
./nexo typecheck   # tipos de API e web
cd e2e && npm i && npx playwright install chromium && BASE=http://localhost:18080 npm run smoke   # fumaça da interface (servidor em modo demonstração)
./nexo backup      # backup do banco;  ./nexo restore-check <arquivo>
./nexo logs api    # logs;  ./nexo down para parar
```

## Estrutura

```
apps/api                Fastify + TypeScript; migrations SQL; identidade, cadastro, rede, financeiro, importação, IPAM, campo, CRM, NOC
apps/web                React + Vite (painel e portal do assinante)
services/network-agent  Agente Python (SQLite, drivers demo e mikrotik_radius)
infra/compose           Ambiente local      infra/site  Agente + RADIUS no provedor      infra/prod  Instalação central
e2e                     Teste de fumaça da interface em navegador (Playwright)
.github/workflows       Integração contínua: tipos, build, auditoria, testes da API e do agente, fumaça da interface
scripts                 Certificados dev, backup/restauração, pacote assinado do agente, laboratório RADIUS
samples                 CSVs sintéticos do importador
```

Expansões pós-MVP: OLT/ONU (`docs/expansao-olt-onu.md`); IPAM/CGNAT, ordens de serviço, estoque, FTTH, CRM e NOC (`docs/expansoes-2-a-5.md`).
O que ficou para depois, em ordem de prioridade: `docs/05-prioridades-pos-projeto.md`.

Simulado x real: os drivers `demo` e `olt_demo` e o gateway `demo` são simulações identificadas na interface e bloqueadas fora do modo
demonstração. A integração MikroTik/PPPoE foi validada em laboratório virtual (CHR 7.24.5), não no equipamento do piloto, e não há gateway de pagamento real integrado.
