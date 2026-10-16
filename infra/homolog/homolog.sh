#!/usr/bin/env bash
# HOMOLOGAÇÃO LOCAL: sobe o NexoISP com a MESMA configuração de produção (infra/prod: sem modo demonstração, MFA obrigatório,
# HTTPS, mTLS dos agentes), em outro projeto do Docker, outro banco e outras portas. Serve para ensaiar antes do corte.
# Não é o ambiente do provedor: o host público, o domínio e o certificado reais continuam por exercitar.
#   homolog.sh up          -> gera segredos e certificados próprios (uma vez), sobe e cria o operador (senha em operador.txt)
#   homolog.sh preflight   -> conferência de entrada em produção (nexo-db preflight)
#   homolog.sh totp <segredo> -> código de 6 dígitos para um segredo TOTP (ensaio automatizado; pessoas usam o aplicativo)
#   homolog.sh ps | logs | down (remove containers) | destroy (remove também o banco e os segredos)
set -euo pipefail
cd "$(dirname "$0")"; ROOT="$(cd ../.. && pwd)"
C="docker compose -p nexoisp-homolog --project-directory $PWD -f $ROOT/infra/prod/docker-compose.yml --env-file $PWD/.env"
case "${1:-}" in
  up)
    if [ ! -f .env ]; then
      umask 077
      { echo "NEXO_DOMAIN=localhost"; echo "NEXO_HTTP_PORT=28080"; echo "NEXO_HTTPS_PORT=28443"; echo "NEXO_AGENT_PORT=28444"
        echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"; echo "NEXO_APP_DB_PASSWORD=$(openssl rand -hex 24)"
        echo "NEXO_GO_DB_PASSWORD=$(openssl rand -hex 24)"; echo "NEXO_RADIUS_DB_PASSWORD=$(openssl rand -hex 24)"; echo "NEXO_RADIUS_KEY=$(openssl rand -hex 24)"
        echo "NEXO_RADIUS_PUBLIC_HOST=localhost"; echo "NEXO_VPN_PUBLIC_HOST=localhost"; echo "NEXO_VPN_PORT=28520";echo "NEXO_RADIUS_PORT=2812";echo "NEXO_RADIUS_ACCT_PORT=2813";echo "NEXO_L2TP_IKE_PORT=28500";echo "NEXO_L2TP_NAT_PORT=28501"
        echo "NEXO_OP_SIGNING_KEY=$(openssl genpkey -algorithm ed25519 -outform DER | base64 -w0)"; echo "NEXO_SECRET_KEY=$(openssl rand -base64 32)"; } > .env
      mkdir -p certs
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 -subj "/CN=NexoISP Homolog Agent CA" -keyout certs/ca.key -out certs/ca.crt 2>/dev/null
      openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=nexo-api" -keyout certs/server.key -out certs/server.csr 2>/dev/null
      openssl x509 -req -in certs/server.csr -CA certs/ca.crt -CAkey certs/ca.key -CAcreateserial -days 365 -out certs/server.crt -extfile <(printf "subjectAltName=DNS:api,DNS:localhost,IP:127.0.0.1") 2>/dev/null
      rm -f certs/server.csr; chmod 644 certs/ca.crt certs/server.crt certs/server.key   # legíveis pelo usuário não privilegiado da API Go
    fi
    # Adoção de um laboratório anterior: acrescente credenciais ausentes sem trocar as existentes.
    for key in NEXO_GO_DB_PASSWORD NEXO_RADIUS_DB_PASSWORD NEXO_RADIUS_KEY; do
      if ! grep -q "^${key}=" .env; then
        (umask 077; printf '\n%s=%s\n' "$key" "$(openssl rand -hex 24)" >> .env)
      fi
    done
    $C build api migrate vpn caddy
    $C up -d --wait db
    $C run --rm migrate prepare
    $C up -d
    for i in $(seq 1 40); do $C exec -T api wget -q -O /dev/null http://localhost:8080/api/health 2>/dev/null && break; sleep 2; done
    if [ ! -f .operator-created ]; then
      PW="$(openssl rand -base64 18)"
      $C run --rm -e NEXO_NEW_PASSWORD="$PW" migrate create-operator operador@homolog.local "Operador Homologação"
      touch .operator-created
      (umask 077; printf 'operador@homolog.local\n%s\n' "$PW" > operador.txt)
      echo "painel: https://localhost:28443  (certificado interno do Caddy: o navegador vai avisar)"
      echo "operador: operador@homolog.local   senha gravada em infra/homolog/operador.txt (apague depois de anotar)"
    else echo "painel: https://localhost:28443 (operador já criado; para trocar a senha rode create-operator de novo)"; fi ;;
  preflight) $C run --rm migrate preflight ;;
  totp) $C run --rm migrate totp "$2" ;;
  operator) $C run --rm -e NEXO_NEW_PASSWORD="$3" migrate create-operator "$2" "Operador Homologação" ;;
  ps) $C ps ;;
  logs) shift; $C logs "$@" ;;
  down) $C down ;;
  destroy) $C down -v; rm -rf .env certs .operator-created operador.txt ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
