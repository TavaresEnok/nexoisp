#!/usr/bin/env bash
# Laboratório PPPoE sobre o cenário Trio do PNETLab (substitui infra/lab, que usava um CHR em container).
# ESCREVE em nós do cenário: só rodar com autorização do dono do laboratório. Tudo o que cria leva a marca "nexo-lab".
#   trio.sh up | down | status | nas '<comando RouterOS>' | cli '<comando RouterOS>' | client up <n> <usuario> <senha> | client down <n> | ros '<caminho>'
# Variáveis: NEXO_DOCKER (ex.: "sudo docker"), NEXO_ROOT (checkout com .env e infra/certs; padrão: este repositório).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="${NEXO_ROOT:-$(cd "$HERE/../.." && pwd)}"
export STATE="$ROOT/.data/lab-pnetlab"
D="${NEXO_DOCKER:-docker}"; C="$D compose -f $HERE/docker-compose.yml --env-file $STATE/.env"
# Concentrador e cliente do teste: WorldFibra (WORLD-MK4011 e WORLD-CLIENTE)
NAS_CON=30125; CLI_CON=30127; NAS_TAP=vunl125_11; NAS_IF=ether12
BR=nexolab0; export HOST_IP=172.30.251.1 NAS_IP=172.30.251.41
NAS_LOCAL_ADDRESS=10.255.255.1; NAS_REMOTE_POOL="POOL REMOTO"
B=http://localhost:18080/api; J='content-type: application/json'
AGENT_NAME="Agente PNETLab (WorldFibra)"; DEVICE_NAME="WORLD-MK4011 CHR 7.17 (PNETLab)"; CRED=trio-world
login() { curl -s $B/auth/login -H "$J" -d '{"email":"admin@alfa.demo","password":"demo1234"}' | jq -r .token; }
nas() { python3 "$HERE/con.py" $NAS_CON "$@"; }
cli() { python3 "$HERE/con.py" $CLI_CON "$@"; }
py() { $D run --rm --network host --security-opt seccomp=unconfined -v "$STATE/config:/out" -v "$HERE/setup_nas.py:/setup_nas.py:ro" \
  -e NAS_IP -e HOST_IP -e RADIUS_NAS_SECRET="$RADIUS_NAS_SECRET" -e NAS_AGENT_PASSWORD="$NAS_AGENT_PASSWORD" \
  -e NAS_LOCAL_ADDRESS="$NAS_LOCAL_ADDRESS" -e NAS_REMOTE_POOL="$NAS_REMOTE_POOL" "$@"; }
case "${1:-}" in
  up)
    mkdir -p "$STATE/config" "$STATE/data"
    # 1. caminho IP servidor <-> concentrador: ponte própria + a placa de gerência (solta) do nó. Não usa a nat0 do PNETLab.
    ip link show $BR >/dev/null 2>&1 || { sudo ip link add $BR type bridge; sudo ip addr add $HOST_IP/24 dev $BR; }
    sudo ip link set $BR up; sudo ip link set $NAS_TAP master $BR
    # 2. cópia da configuração antes da primeira mudança (fica no próprio nó) e endereço na placa de gerência
    nas ':if ([:len [/file find name="antes-nexo.rsc"]] = 0) do={/export file=antes-nexo}' \
        ":if ([:len [/ip address find comment=\"nexo-lab\"]] = 0) do={/ip address add address=$NAS_IP/24 interface=$NAS_IF comment=nexo-lab}" >/dev/null
    for i in $(seq 1 10); do ping -c1 -W1 $NAS_IP >/dev/null 2>&1 && break; sleep 1; done
    # 3. agente e equipamento no painel; segredos locais
    H="authorization: Bearer $(login)"
    if [ ! -f "$STATE/.env" ]; then
      AID=$(curl -s $B/agents -H "$H" | jq -r --arg n "$AGENT_NAME" '.[] | select(.name==$n) | .id')
      if [ -n "$AID" ]; then A=$(curl -s -X PATCH $B/agents/$AID -H "$H" -H "$J" -d '{"rotate_token":true,"status":"active","reset_certificate":true}')
      else A=$(curl -s $B/agents -H "$H" -H "$J" -d "{\"name\":\"$AGENT_NAME\"}"); AID=$(echo "$A" | jq -r .id); fi
      { echo "NEXO_AGENT_ID=$AID"; echo "NEXO_AGENT_TOKEN=$(echo "$A" | jq -r .token)"; echo "RADIUS_NAS_SECRET=$(openssl rand -hex 12)"
        echo "NAS_AGENT_PASSWORD=$(openssl rand -hex 12)"; echo "NAS_IP=$NAS_IP"; echo "STATE=$STATE"; } > "$STATE/.env"; chmod 600 "$STATE/.env"
      "$ROOT/scripts/dev-certs.sh" agent "$AID" "$STATE/certs" >/dev/null; chmod 644 "$STATE/certs/agent.key"
      [ -n "$(curl -s $B/devices -H "$H" | jq -r --arg n "$DEVICE_NAME" '.[] | select(.name==$n) | .id')" ] || \
        curl -s $B/devices -H "$H" -H "$J" -d "{\"name\":\"$DEVICE_NAME\",\"driver\":\"mikrotik_radius\",\"host\":\"$NAS_IP\",\"api_port\":8729,\"credential_ref\":\"$CRED\",\"agent_id\":\"$AID\"}" | jq -c '{id,name}'
    fi
    set -a; . "$STATE/.env"; set +a
    printf '{"%s": {"username": "nexo-agent", "password": "%s", "ca_file": "/config/routeros-ca.crt"}}\n' "$CRED" "$NAS_AGENT_PASSWORD" > "$STATE/config/credentials.json"
    # 4. RADIUS local, configuração do concentrador pela API e agente
    $C up -d --build radius
    py -u "$(id -u)" nexoisp-agent python /setup_nas.py up
    $C up -d agent ;;
  down)
    set -a; . "$STATE/.env"; set +a
    py nexoisp-agent python /setup_nas.py down || echo "AVISO: concentrador não foi limpo pela API; confira com: trio.sh nas '/radius print'"
    cli '/interface pppoe-client remove [find comment="nexo-lab"]' '/interface vlan remove [find comment="nexo-lab"]' >/dev/null
    nas '/ip address remove [find comment="nexo-lab"]' >/dev/null
    $C down; sudo ip link set $NAS_TAP nomaster; sudo ip link del $BR
    echo "desfeito. O estado local ficou em $STATE (apague para recomeçar do zero); antes-nexo.rsc continua no concentrador." ;;
  status)
    ip -br addr show $BR 2>/dev/null || echo "ponte $BR ausente"; $C ps 2>/dev/null || true
    nas '/ppp aaa print' '/radius print' '/ppp active print' ;;
  nas) shift; nas "$@" ;;
  cli) shift; cli "$@" ;;
  client)  # clientes PPPoE adicionais no nó cliente, um por VLAN de PON (n = 2..8); o pppoe-lab do cenário (VLAN 301) não é tocado
    n="$3"; case "$n" in [2-8]) ;; *) echo "n deve ser 2..8"; exit 1 ;; esac
    case "$2" in
      up) cli ":if ([:len [/interface vlan find name=nexo-v30$n]] = 0) do={/interface vlan add name=nexo-v30$n interface=ether1 vlan-id=30$n comment=nexo-lab}" \
              "/interface pppoe-client remove [find name=nexo-c$n]" \
              "/interface pppoe-client add name=nexo-c$n interface=nexo-v30$n user=\"$4\" password=\"$5\" add-default-route=no use-peer-dns=no disabled=no comment=nexo-lab" ;;
      down) cli "/interface pppoe-client remove [find name=nexo-c$n]" ;;
    esac ;;
  ros) set -a; . "$STATE/.env"; set +a
    $D run --rm --network host --security-opt seccomp=unconfined -v "$STATE/config:/c:ro" -e P="$NAS_AGENT_PASSWORD" -e H="$NAS_IP" nexoisp-agent python -c "
import os,sys,json,ssl
from librouteros import connect
ctx=ssl.create_default_context(cafile='/c/routeros-ca.crt'); h=os.environ['H']
api=connect(host=h,username='nexo-agent',password=os.environ['P'],port=8729,timeout=10,ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname=h))
for r in api.path(*sys.argv[1].split('/')): print(json.dumps(r, default=str))" "$2" ;;
  *) sed -n '2,5p' "$0" ;;
esac
