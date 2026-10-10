#!/usr/bin/env bash
# Sobe o laboratório PPPoE e o registra no painel local de demonstração (Provedor Alfa).
#   lab.sh up (LAB_PPP_AUTH=mschap2 para MS-CHAPv2 + hash NT) | down | client <args do pppoe-client.sh> | ros '<caminho>' (ex.: ros ppp/active) | cgnat | radius-ha [usuario]
set -euo pipefail
cd "$(dirname "$0")"; ROOT="$(cd ../.. && pwd)"
C="docker compose"
B=http://localhost:18080/api; J='content-type: application/json'
login() { curl -s $B/auth/login -H "$J" -d '{"email":"admin@alfa.demo","password":"demo1234"}' | jq -r .token; }
case "${1:-}" in
  up)
    [ -f chr/chr-7.24.5.img ] || { echo "baixe chr-7.24.5.img.zip de download.mikrotik.com/routeros/7.24.5/ e extraia em infra/lab/chr/"; exit 1; }
    H="authorization: Bearer $(login)"
    if [ ! -f .env ]; then
      AID=$(curl -s $B/agents -H "$H" | jq -r '.[] | select(.name=="Agente Lab CHR") | .id')
      if [ -n "$AID" ]; then A=$(curl -s -X PATCH $B/agents/$AID -H "$H" -H "$J" -d '{"rotate_token":true,"status":"active","reset_certificate":true}')   # laboratório recriado: nova credencial
      else A=$(curl -s $B/agents -H "$H" -H "$J" -d '{"name":"Agente Lab CHR"}'); AID=$(echo "$A" | jq -r .id); fi
      { echo "NEXO_AGENT_ID=$AID"; echo "NEXO_AGENT_TOKEN=$(echo "$A" | jq -r .token)"; echo "RADIUS_NAS_SECRET=$(openssl rand -hex 12)"
        echo "RADIUS_NAS_NET=$(docker network inspect nexoisp_default -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
        echo "CHR_AGENT_PASSWORD=$(openssl rand -hex 12)"; echo "CHR_ADMIN_PASSWORD=$(openssl rand -hex 12)"; } > .env
      chmod 600 .env
      "$ROOT/scripts/dev-certs.sh" agent "$AID" "$PWD/certs" >/dev/null; chmod 644 certs/agent.key
      [ -n "$(curl -s $B/devices -H "$H" | jq -r '.[] | select(.name=="MikroTik CHR 7.24.5 (lab)") | .id')" ] || \
        curl -s $B/devices -H "$H" -H "$J" -d "{\"name\":\"MikroTik CHR 7.24.5 (lab)\",\"driver\":\"mikrotik_radius\",\"host\":\"lab-chr\",\"api_port\":8729,\"credential_ref\":\"lab-chr\",\"agent_id\":\"$AID\"}" | jq -c '{id,name}'
    fi
    set -a; . ./.env; set +a
    # LAB_PPP_AUTH=mschap2 => NAS só aceita MS-CHAPv2 e o RADIUS local guarda apenas o hash NT (sem senha em claro no disco)
    export LAB_PPP_AUTH="${LAB_PPP_AUTH:-mschap2,chap}"; STORAGE=cleartext; [ "$LAB_PPP_AUTH" = mschap2 ] && STORAGE=nt_hash
    printf '{"lab-chr": {"username": "nexo-agent", "password": "%s", "ca_file": "/config/routeros-ca.crt", "password_storage": "%s"}}\n' "$CHR_AGENT_PASSWORD" "$STORAGE" > config/credentials.json
    $C up -d --build chr radius
    docker run --rm -u "$(id -u)" --network nexoisp_default -v "$PWD/config:/out" -e LAB_PPP_AUTH -e CHR_HOST=lab-chr -e RADIUS_HOST=lab-radius -e RADIUS_NAS_SECRET -e CHR_AGENT_PASSWORD -e CHR_ADMIN_PASSWORD \
      -v "$PWD/setup_chr.py:/setup_chr.py:ro" nexoisp-agent python /setup_chr.py
    $C up -d --build agent ;;
  down) $C down -v; rm -rf .env certs config/credentials.json config/routeros-ca.crt ;;
  client) shift; docker exec lab-chr pppoe-client.sh "$@" ;;
  ros) set -a; . ./.env; set +a
    docker run --rm --network nexoisp_default -v "$PWD/config:/c:ro" -e P="$CHR_AGENT_PASSWORD" nexoisp-agent python -c "
import os,sys,json
from librouteros import connect
import ssl; ctx=ssl.create_default_context(cafile='/c/routeros-ca.crt')
api=connect(host='lab-chr',username='nexo-agent',password=os.environ['P'],port=8729,timeout=10,ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname='lab-chr'))
for r in api.path(*sys.argv[1].split('/')): print(json.dumps(r, default=str))" "$2" ;;
  cgnat)  # prova do CGNAT determinístico no CHR: aplica as regras geradas, passa tráfego dos clientes PPPoE, confere a tradução e remove
    set -a; . ./.env; set +a
    H="authorization: Bearer $(login)"; T=$(mktemp -d)
    pool() { curl -s $B/ipam/pools -H "$H" | jq -r --arg n "$1" '.[] | select(.name==$n) | .id'; }
    PRIV=$(pool "PPPoE lab (CHR)"); [ -n "$PRIV" ] || PRIV=$(curl -s $B/ipam/pools -H "$H" -H "$J" -d '{"name":"PPPoE lab (CHR)","cidr":"100.64.0.0/24","kind":"cgnat"}' | jq -r .id)
    PUB=$(pool "Saída lab (documentação)"); [ -n "$PUB" ] || PUB=$(curl -s $B/ipam/pools -H "$H" -H "$J" -d '{"name":"Saída lab (documentação)","cidr":"198.51.100.0/30","kind":"public"}' | jq -r .id)
    PLAN=$(curl -s $B/cgnat/plans -H "$H" | jq -r --arg p "$PRIV" '.[] | select(.private_pool_id==$p and .retired_at==null) | .id')
    [ -n "$PLAN" ] || PLAN=$(curl -s $B/cgnat/plans -H "$H" -H "$J" -d "{\"name\":\"CGNAT lab\",\"public_pool_id\":\"$PUB\",\"private_pool_id\":\"$PRIV\",\"ports_per_subscriber\":960}" | jq -r .id)
    curl -s "$B/cgnat/plans/$PLAN/script" -H "$H" > "$T/cgnat.rsc"; chmod -R a+rX "$T"; TAG="nexo-cgnat:${PLAN:0:8}"
    ros() { docker run --rm --network nexoisp_default -v "$PWD/config:/c:ro" -v "$PWD/cgnat_check.py:/cgnat_check.py:ro" -v "$T:/t:ro" -e P="$CHR_AGENT_PASSWORD" nexoisp-agent python /cgnat_check.py "$@"; }
    ros remove "$TAG" >/dev/null; ros apply /t/cgnat.rsc; sleep 3
    DP=$((20000 + RANDOM % 9999))   # porta de destino única: só os fluxos desta execução entram na conferência
    for a in $(docker exec lab-chr sh -c "ip -4 -o addr show | awk '/ppp/{print \$2\"=\"\$4}'"); do
      docker exec lab-chr sh -c "ip route replace 198.18.0.1/32 dev ${a%%=*}; echo x | nc -u -w1 -s ${a##*=} 198.18.0.1 $DP; nc -w1 -s ${a##*=} 198.18.0.1 $DP </dev/null" >/dev/null 2>&1 || true
    done
    docker exec lab-chr ip route del 198.18.0.1/32 2>/dev/null || true
    ros conns "$DP" > "$T/conns"; OK=0; BAD=0
    while read -r c; do
      SRC=$(echo "$c" | jq -r '."src-address"'); NIP=$(echo "$c" | jq -r '."reply-dst-address"'); PORT=$(echo "$c" | jq -r '."reply-dst-port"'); PROTO=$(echo "$c" | jq -r .protocol)
      E=$(curl -s "$B/cgnat/plans/$PLAN/lookup?private_ip=$SRC" -H "$H"); EIP=$(echo "$E" | jq -r .public_ip); LO=$(echo "$E" | jq -r .port_start); HI=$(echo "$E" | jq -r .port_end)
      if [ "$NIP" = "$EIP" ] && [ "$PORT" -ge "$LO" ] && [ "$PORT" -le "$HI" ]; then OK=$((OK+1)); R=ok; else BAD=$((BAD+1)); R=DIVERGENTE; fi
      echo "$R  $PROTO $SRC -> $NIP:$PORT  (calculado: $EIP:$LO-$HI)"
    done < "$T/conns"
    ros remove "$TAG"; rm -rf "$T"
    echo "traduções conferidas: $OK ok, $BAD divergente(s)"; [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] ;;
  radius-ha)  # prova de redundância: 2ª instância do RADIUS sobre o mesmo banco; para a principal e um cliente real precisa reautenticar
    set -a; . ./.env; set +a
    $C up -d --build radius2 >/dev/null 2>&1; sleep 4
    py() { docker run --rm --network nexoisp_default -v "$PWD/config:/c:ro" -e P="$CHR_AGENT_PASSWORD" -e R2="$(getent hosts lab-radius2 2>/dev/null | awk '{print $1}')" -e SECRET="$RADIUS_NAS_SECRET" nexoisp-agent python -c "
import os,sys,socket,ssl
from librouteros import connect
ctx=ssl.create_default_context(cafile='/c/routeros-ca.crt')
api=connect(host='lab-chr',username='nexo-agent',password=os.environ['P'],port=8729,timeout=10,ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname='lab-chr'))
m=sys.argv[1]
if m=='add':
    ip=socket.gethostbyname('lab-radius2'); r=api.path('radius')
    if not [x for x in r if x.get('address')==ip]: r.add(service='ppp', address=ip, secret=os.environ['SECRET'], timeout='3s')
    print('servidores RADIUS no NAS:', [x.get('address') for x in r])
elif m=='kick':
    p=api.path('ppp','active'); ids=[x['.id'] for x in p if x['name']==sys.argv[2]]
    if ids: p.remove(*ids)
    print('sessão derrubada:', sys.argv[2], len(ids))
elif m=='who':
    print([(x['name'], x['address'], x['uptime']) for x in api.path('ppp','active') if x['name']==sys.argv[2]])
" "$@"; }
    U=${2:-marcos1000}
    py add
    docker stop lab-radius >/dev/null; echo "RADIUS principal PARADO"
    py kick "$U"; sleep 15; W=$(py who "$U"); echo "com a principal parada, sessão de $U: $W"
    docker start lab-radius >/dev/null; echo "RADIUS principal religado"
    case "$W" in *"$U"*) echo "ok: o cliente reautenticou pela segunda instância" ;; *) echo "FALHA: o cliente não reautenticou"; exit 1 ;; esac ;;
  *) sed -n '2,3p' "$0" ;;
esac
