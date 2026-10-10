#!/usr/bin/env bash
# Certificados de DESENVOLVIMENTO para mTLS dos agentes (ADR-006). Não usar em produção.
#   dev-certs.sh init                 -> CA + certificado do servidor (infra/certs)
#   dev-certs.sh agent <agent_id> <dir_saida> -> certificado individual do agente (CN=agent:<id>)
set -euo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)/infra/certs"
mkdir -p "$D"
case "$1" in
  init)
    [ -f "$D/ca.key" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj "/CN=NexoISP Dev Agent CA" -keyout "$D/ca.key" -out "$D/ca.crt" 2>/dev/null
    if [ ! -f "$D/server.crt" ]; then
      openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=nexo-api" -keyout "$D/server.key" -out "$D/server.csr" 2>/dev/null
      openssl x509 -req -in "$D/server.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" -CAcreateserial -days 825 -out "$D/server.crt" \
        -extfile <(printf "subjectAltName=DNS:api,DNS:localhost,IP:127.0.0.1%s" "${NEXO_API_SAN:+,$NEXO_API_SAN}") 2>/dev/null
      rm -f "$D/server.csr"
    fi ;;
  agent)
    id="$2"; out="$3"; mkdir -p "$out"
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=agent:$id" -keyout "$out/agent.key" -out "$out/agent.csr" 2>/dev/null
    openssl x509 -req -in "$out/agent.csr" -CA "$D/ca.crt" -CAkey "$D/ca.key" -CAcreateserial -days 398 -out "$out/agent.crt" \
      -extfile <(printf "extendedKeyUsage=clientAuth") 2>/dev/null
    rm -f "$out/agent.csr"; cp "$D/ca.crt" "$out/ca.crt"; chmod 600 "$out/agent.key"
    echo "certificado do agente $id em $out (validade 398 dias)" ;;
  *) echo "uso: $0 init | agent <id> <dir>"; exit 1 ;;
esac
