# Pilha tecnológica do NexoISP (conferida nos arquivos de dependências em 15/10/2026)

## API — `apps/api` (Node 22 + TypeScript)
- Produção (5): fastify 5.12.5 · @fastify/static 10.1.6 · pg 8.23.1 · zod 3.25.76 · otplib 12.0.1
- Desenvolvimento: typescript 5.9.3 · tsx 4.23.15 · vitest 5.0.4 (usa vite 8.3.4) · @types/node 22.20.5 · @types/pg 8.23.1
- Do próprio Node (sem pacote): crypto (scrypt, AES-256-GCM, SHA-256, X25519 do túnel), dgram (RADIUS/desconexão RFC 5176), fetch, child_process (serviço do túnel)
- Sem ORM, sem NestJS: SQL à mão, isolamento por provedor com RLS no PostgreSQL

## Painel — `apps/web` (React + TypeScript)
- Produção (5): react 18.3.1 · react-dom 18.3.1 · react-router-dom 7.18.4 · @fontsource-variable/atkinson-hyperlegible-next 5.3.0 · @fontsource-variable/atkinson-hyperlegible-mono 5.3.0
- Desenvolvimento: vite 6.4.4 · @vitejs/plugin-react 4.7.0 · typescript 5.9.3 · @types/react 18.3.31 · @types/react-dom 18.3.7
- Componentes, ícones, gráficos e mapa feitos à mão (sem biblioteca de componentes nem de mapas); blocos do mapa do OpenStreetMap

## Totais npm (com dependências indiretas, package-lock.json)
- 101 pacotes em produção · 158 só de desenvolvimento · `npm audit`: 0 vulnerabilidades

## Agente local (opcional) — `services/network-agent` (Python 3.12, imagem python:3.12-slim)
- httpx 0.28.1 · cryptography 44.0.0 · pydantic 2.10.4 · librouteros 3.4.1 (API do RouterOS) · netmiko 4.5.0 + paramiko 3.5.0 (SSH) · passlib 1.7.4 · SQLite (da biblioteca padrão)

## Serviços do Docker Compose
| Serviço | Imagem / base | Papel |
|---|---|---|
| db | postgres:16-alpine | banco principal |
| db-replica (perfil ha) | postgres:16-alpine | réplica em espera |
| api | node:22-alpine | API + painel compilado + rotinas |
| vpn | mesma imagem da API + wireguard-tools-wg, iproute2, strongswan, xl2tpd, ppp-daemon | túnel WireGuard e L2TP/IPsec |
| radius / radius2 (ha) | freeradius/freeradius-server 3.2 (módulos sql/postgresql e cache) | autenticação integrada |
| acs (perfil acs) | drumsergio/genieacs:1.2.13 (imagem comunitária) | gerência de roteadores TR-069 |
| acs-db (perfil acs) | mongo:7.0 | banco da gerência de roteadores |
| caddy (produção) | caddy:2-alpine | HTTPS automático |
| agent-demo (demonstração) | python:3.12-slim | agente simulado |

## Ferramentas, testes e laboratório
- e2e: playwright 1.49.1 (imagem mcr.microsoft.com/playwright:v1.49.1-jammy) — `./nexo e2e`
- tools/sgp-migracao: scripts Python (biblioteca padrão) para extrair do SGP
- infra/lab e infra/lab-pnetlab: scripts Python/shell; MikroTik CHR 7.17 (cenário PNETLab); emulador de OLT Huawei (nosso); simulador de roteador TR-069 genieacs-sim (só laboratório)
- Orquestração: Docker Compose + script `./nexo`; CI: GitHub Actions
