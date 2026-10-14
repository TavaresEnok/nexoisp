#!/usr/bin/env bash
# Laboratório PPPoE sobre o cenário Trio do PNETLab (substitui infra/lab, que usava um CHR em container).
# ESCREVE em nós do cenário: só rodar com autorização do dono do laboratório. Tudo o que cria leva a marca "nexo-lab".
#   trio.sh up | down | status | radius-ha [usuario] | cgnat <n>... | nas '<comando RouterOS>' | cli '<comando RouterOS>' | client up <n> <usuario> <senha> | client down <n> | ipoe [mac] | hotspot <usuario> <senha> | ros '<caminho>'
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
nas() { python3 "$HERE/ros_console.py" $NAS_CON "$@"; }
cli() { python3 "$HERE/ros_console.py" $CLI_CON "$@"; }
py() { $D run --rm --network host --security-opt seccomp=unconfined -v "$STATE/config:/out" -v "$HERE/setup_nas.py:/setup_nas.py:ro" \
  -e NAS_IP="$NAS_IP" -e HOST_IP="$HOST_IP" -e RADIUS_NAS_SECRET="$RADIUS_NAS_SECRET" -e NAS_AGENT_PASSWORD="$NAS_AGENT_PASSWORD" \
  -e NAS_LOCAL_ADDRESS="$NAS_LOCAL_ADDRESS" -e NAS_REMOTE_POOL="$NAS_REMOTE_POOL" "$@"; }
radius_image() {  # mesma receita de infra/site/radius/Dockerfile, por container + commit: o build deste Docker não aceita seccomp=unconfined
  [ -z "$($D images -q nexoisp-site-radius)" ] || return 0
  local R="$HERE/../site/radius" N=nexo-radius-build; $D rm -f $N >/dev/null 2>&1 || true
  $D create --name $N --network host --security-opt seccomp=unconfined --entrypoint sh freeradius/freeradius-server:latest-3.2 -c \
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends sqlite3 >/dev/null && rm -rf /var/lib/apt/lists/* && groupadd -g 10001 nexodata && usermod -aG nexodata freerad && ln -sf ../mods-available/sql /etc/raddb/mods-enabled/sql && chmod +x /nexo-entrypoint.sh' >/dev/null
  $D cp "$R/sql" $N:/etc/raddb/mods-available/sql; $D cp "$R/clients.conf" $N:/etc/raddb/clients.conf; $D cp "$R/entrypoint.sh" $N:/nexo-entrypoint.sh
  $D start -a $N >/dev/null
  $D commit --change 'ENTRYPOINT ["/nexo-entrypoint.sh"]' --change 'CMD ["freeradius","-f","-l","stdout"]' $N nexoisp-site-radius >/dev/null; $D rm $N >/dev/null
}
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
        echo "NAS_AGENT_PASSWORD=$(openssl rand -hex 12)"; echo "NAS_IP=$NAS_IP"; echo "HOST_IP=$HOST_IP"; echo "STATE=$STATE"; } > "$STATE/.env"; chmod 600 "$STATE/.env"
      "$ROOT/scripts/dev-certs.sh" agent "$AID" "$STATE/certs" >/dev/null; chmod 644 "$STATE/certs/agent.key"
      [ -n "$(curl -s $B/devices -H "$H" | jq -r --arg n "$DEVICE_NAME" '.[] | select(.name==$n) | .id')" ] || \
        curl -s $B/devices -H "$H" -H "$J" -d "{\"name\":\"$DEVICE_NAME\",\"driver\":\"mikrotik_radius\",\"host\":\"$NAS_IP\",\"api_port\":8729,\"credential_ref\":\"$CRED\",\"agent_id\":\"$AID\"}" | jq -c '{id,name}'
    fi
    set -a; . "$STATE/.env"; set +a
    printf '{"%s": {"username": "nexo-agent", "password": "%s", "ca_file": "/config/routeros-ca.crt"}}\n' "$CRED" "$NAS_AGENT_PASSWORD" > "$STATE/config/credentials.json"
    # 4. RADIUS local, configuração do concentrador pela API e agente
    radius_image; $C up -d radius
    py -u "$(id -u)" nexoisp-agent python /setup_nas.py up
    $C up -d agent ;;
  down)
    set -a; . "$STATE/.env"; set +a
    py nexoisp-agent python /setup_nas.py down || echo "AVISO: concentrador não foi limpo pela API; confira com: trio.sh nas '/radius print'"
    cli '/interface pppoe-client remove [find comment="nexo-lab"]' '/ip dhcp-client remove [find comment="nexo-lab"]' '/interface macvlan remove [find comment="nexo-lab"]' '/interface vlan remove [find comment="nexo-lab"]' >/dev/null
    nas '/ip hotspot remove [find name=nexo-hs]' '/ip hotspot profile remove [find name=nexo-hs]' '/ip dhcp-server remove [find comment="nexo-lab"]' '/ip dhcp-server network remove [find comment="nexo-lab"]' '/ip pool remove [find comment="nexo-lab"]' \
        '/ip address remove [find comment~"nexo-lab"]' '/interface vlan remove [find comment="nexo-lab"]' >/dev/null
    $C --profile ha down; sudo ip link set $NAS_TAP nomaster; sudo ip link del $BR
    echo "desfeito. O estado local ficou em $STATE (apague para recomeçar do zero); antes-nexo.rsc continua no concentrador." ;;
  ipoe)  # IPoE no cenário: VLAN 309 com DHCP autorizado pelo RADIUS no concentrador e um cliente DHCP (MAC próprio) no nó cliente
    MAC="${2:-02:4E:58:00:00:19}"
    nas ':if ([:len [/interface vlan find name=nexo-v309]] = 0) do={/interface vlan add name=nexo-v309 interface=ether7 vlan-id=309 comment=nexo-lab}' \
        ':if ([:len [/ip address find comment="nexo-lab-ipoe"]] = 0) do={/ip address add address=10.99.9.1/24 interface=nexo-v309 comment=nexo-lab-ipoe}' \
        ':if ([:len [/ip pool find name=nexo-ipoe]] = 0) do={/ip pool add name=nexo-ipoe ranges=10.99.9.10-10.99.9.50 comment=nexo-lab}' \
        ':if ([:len [/ip dhcp-server find name=nexo-ipoe]] = 0) do={/ip dhcp-server add name=nexo-ipoe interface=nexo-v309 address-pool=nexo-ipoe use-radius=yes comment=nexo-lab disabled=no}' \
        ':if ([:len [/ip dhcp-server network find comment="nexo-lab"]] = 0) do={/ip dhcp-server network add address=10.99.9.0/24 gateway=10.99.9.1 comment=nexo-lab}' \
        '/radius set [find comment~"nexo"] service=ppp,dhcp' >/dev/null
    cli ':if ([:len [/interface vlan find name=nexo-v309]] = 0) do={/interface vlan add name=nexo-v309 interface=ether1 vlan-id=309 comment=nexo-lab}' \
        ":if ([:len [/interface macvlan find name=nexo-m9]] = 0) do={/interface macvlan add name=nexo-m9 interface=nexo-v309 mac-address=$MAC mode=private comment=nexo-lab}" \
        ':if ([:len [/ip dhcp-client find interface=nexo-m9]] = 0) do={/ip dhcp-client add interface=nexo-m9 add-default-route=no use-peer-dns=no comment=nexo-lab disabled=no}' >/dev/null
    echo "pronto: cadastre a conta IPoE com o MAC $MAC e confira com: trio.sh nas '/ip dhcp-server lease print detail where server=nexo-ipoe'" ;;
  hotspot)  # hotspot no cenário: VLAN 310 com página de acesso autorizada pelo RADIUS; o nó cliente pega DHCP e faz o login por HTTP
    U="${2:?usuario}"; P="${3:?senha}"
    nas ':if ([:len [/interface vlan find name=nexo-v310]] = 0) do={/interface vlan add name=nexo-v310 interface=ether7 vlan-id=310 comment=nexo-lab}' \
        ':if ([:len [/ip address find comment="nexo-lab-hs"]] = 0) do={/ip address add address=10.99.10.1/24 interface=nexo-v310 comment=nexo-lab-hs}' \
        ':if ([:len [/ip pool find name=nexo-hs]] = 0) do={/ip pool add name=nexo-hs ranges=10.99.10.10-10.99.10.50 comment=nexo-lab}' \
        ':if ([:len [/ip dhcp-server find name=nexo-hs]] = 0) do={/ip dhcp-server add name=nexo-hs interface=nexo-v310 address-pool=nexo-hs comment=nexo-lab disabled=no}' \
        ':if ([:len [/ip dhcp-server network find address="10.99.10.0/24"]] = 0) do={/ip dhcp-server network add address=10.99.10.0/24 gateway=10.99.10.1 comment=nexo-lab}' \
        ':if ([:len [/ip hotspot profile find name=nexo-hs]] = 0) do={/ip hotspot profile add name=nexo-hs hotspot-address=10.99.10.1 login-by=http-pap use-radius=yes radius-accounting=yes radius-interim-update=5m}' \
        ':if ([:len [/ip hotspot find name=nexo-hs]] = 0) do={/ip hotspot add name=nexo-hs interface=nexo-v310 address-pool=nexo-hs profile=nexo-hs disabled=no}' \
        '/radius set [find comment~"nexo"] service=ppp,hotspot,dhcp' >/dev/null
    cli ':if ([:len [/interface vlan find name=nexo-v310]] = 0) do={/interface vlan add name=nexo-v310 interface=ether1 vlan-id=310 comment=nexo-lab}' \
        ':if ([:len [/interface macvlan find name=nexo-m10]] = 0) do={/interface macvlan add name=nexo-m10 interface=nexo-v310 mac-address=02:4E:58:00:00:1A mode=private comment=nexo-lab}' \
        ':if ([:len [/ip dhcp-client find interface=nexo-m10]] = 0) do={/ip dhcp-client add interface=nexo-m10 add-default-route=no use-peer-dns=no comment=nexo-lab disabled=no}' >/dev/null
    sleep 8; cli "/tool fetch url=\"http://10.99.10.1/login?username=$U&password=$P\" mode=http output=none" >/dev/null || true
    nas '/log print terse where topics~"hotspot"' | tail -3 ;;
  radius-ha)  # 2ª instância do RADIUS sobre o mesmo banco: para a principal, derruba a sessão e o cliente precisa reautenticar pela segunda
    set -a; . "$STATE/.env"; set +a; U="${2:-nexo-w2}"
    $C --profile ha up -d radius2 >/dev/null 2>&1; sleep 4
    rpy() { $D run --rm --network host --security-opt seccomp=unconfined -v "$STATE/config:/c:ro" -e P="$NAS_AGENT_PASSWORD" -e H="$NAS_IP" -e R="$HOST_IP" -e SECRET="$RADIUS_NAS_SECRET" nexoisp-agent python -c "
import os,sys,ssl
from librouteros import connect
ctx=ssl.create_default_context(cafile='/c/routeros-ca.crt'); h=os.environ['H']
api=connect(host=h,username='nexo-agent',password=os.environ['P'],port=8729,timeout=10,ssl_wrapper=lambda s: ctx.wrap_socket(s, server_hostname=h))
m=sys.argv[1]
if m=='add':
    r=api.path('radius')
    if not [x for x in r if str(x.get('authentication-port'))=='1822']:
        r.add(service='ppp', address=os.environ['R'], secret=os.environ['SECRET'], timeout='3s', comment='nexo-lab', **{'authentication-port': 1822, 'accounting-port': 1823, 'src-address': h})
    print('servidores RADIUS no NAS:', [(x.get('address'), x.get('authentication-port')) for x in r])
elif m=='kick':
    p=api.path('ppp','active'); ids=[x['.id'] for x in p if x['name']==sys.argv[2]]
    if ids: p.remove(*ids)
    print('sessão derrubada:', sys.argv[2], len(ids))
elif m=='who':
    print([(x['name'], x['address'], x['uptime']) for x in api.path('ppp','active') if x['name']==sys.argv[2]])
" "$@"; }
    rpy add
    $D stop nexo-trio-radius-1 >/dev/null; echo "RADIUS principal PARADO"
    rpy kick "$U"; sleep 25; W=$(rpy who "$U"); echo "com a principal parada, sessão de $U: $W"
    $D start nexo-trio-radius-1 >/dev/null; echo "RADIUS principal religado"
    case "$W" in *"$U"*) echo "ok: o cliente reautenticou pela segunda instância" ;; *) echo "FALHA: o cliente não reautenticou"; exit 1 ;; esac ;;
  cgnat)  # CGNAT determinístico no concentrador do cenário: aplica as regras geradas ANTES do NAT que o nó já tem, passa tráfego dos clientes
          # nexo-c<n> (precisam ter IP fixo dentro do bloco privado do plano), confere a tradução e remove as regras.
    set -a; . "$STATE/.env"; set +a; shift
    H="authorization: Bearer $(login)"; T=$(mktemp -d)
    PLAN=$(curl -s $B/cgnat/plans -H "$H" | jq -r '.[] | select(.name=="CGNAT lab" and .retired_at==null) | .id')
    [ -n "$PLAN" ] || { echo "crie o plano de CGNAT \"CGNAT lab\" no painel (./nexo lab cgnat fazia isso no laboratório antigo)"; exit 1; }
    curl -s "$B/cgnat/plans/$PLAN/script" -H "$H" > "$T/cgnat.rsc"; chmod -R a+rX "$T"; TAG="nexo-cgnat:${PLAN:0:8}"
    ros() { $D run --rm --network host --security-opt seccomp=unconfined -v "$STATE/config:/c:ro" -v "$HERE/../lab/cgnat_check.py:/cgnat_check.py:ro" -v "$T:/t:ro" \
      -e P="$NAS_AGENT_PASSWORD" -e H="$NAS_IP" -e CGNAT_FIRST=1 nexoisp-agent python /cgnat_check.py "$@"; }
    ros remove "$TAG" >/dev/null; ros apply /t/cgnat.rsc; sleep 2
    DP=$((20000 + RANDOM % 9999))   # porta de destino única: só os fluxos desta execução entram na conferência
    for n in "$@"; do
      cli '/ip route remove [find comment="nexo-lab-cgnat"]' "/ip route add dst-address=198.18.0.1/32 gateway=nexo-c$n comment=nexo-lab-cgnat" \
          ":execute {/tool fetch url=\"http://198.18.0.1:$DP/\" output=none}" ":execute {:resolve nexo.test server=198.18.0.1 server-port=$DP}" ':delay 3s' >/dev/null
    done
    cli '/ip route remove [find comment="nexo-lab-cgnat"]' >/dev/null
    ros conns "$DP" > "$T/conns"; OK=0; BAD=0
    while read -r c; do
      SRC=$(echo "$c" | jq -r '."src-address"'); NIP=$(echo "$c" | jq -r '."reply-dst-address"'); PORT=$(echo "$c" | jq -r '."reply-dst-port"'); PROTO=$(echo "$c" | jq -r .protocol)
      E=$(curl -s "$B/cgnat/plans/$PLAN/lookup?private_ip=$SRC" -H "$H"); EIP=$(echo "$E" | jq -r .public_ip); LO=$(echo "$E" | jq -r .port_start); HI=$(echo "$E" | jq -r .port_end)
      if [ "$NIP" = "$EIP" ] && [ "$PORT" -ge "$LO" ] && [ "$PORT" -le "$HI" ]; then OK=$((OK+1)); R=ok; else BAD=$((BAD+1)); R=DIVERGENTE; fi
      echo "$R  $PROTO $SRC -> $NIP:$PORT  (calculado: $EIP:$LO-$HI)"
    done < "$T/conns"
    ros remove "$TAG"; rm -rf "$T"
    echo "traduções conferidas: $OK ok, $BAD divergente(s)"; [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] ;;
  status)
    ip -br addr show $BR 2>/dev/null || echo "ponte $BR ausente"; $C ps 2>/dev/null || true
    nas '/ppp aaa print' '/radius print' '/ppp active print' ;;
  nas) shift; nas "$@" ;;
  cli) shift; cli "$@" ;;
  client)  # clientes PPPoE adicionais no nó cliente, um por VLAN de PON (n = 2..8); o pppoe-lab do cenário (VLAN 301) não é tocado
    n="$3"; case "$n" in [2-8]) ;; *) echo "n deve ser 2..8"; exit 1 ;; esac
    case "$2" in
      # MAC próprio por cliente (macvlan): com o MAC da placa, o concentrador derruba a sessão do pppoe-lab quando outra conecta
      up) cli "/interface pppoe-client remove [find name=nexo-c$n]" \
              ":if ([:len [/interface vlan find name=nexo-v30$n]] = 0) do={/interface vlan add name=nexo-v30$n interface=ether1 vlan-id=30$n comment=nexo-lab}" \
              ":if ([:len [/interface macvlan find name=nexo-m$n]] = 0) do={/interface macvlan add name=nexo-m$n interface=nexo-v30$n mac-address=02:4E:58:00:00:0$n mode=private comment=nexo-lab}" \
              "/interface pppoe-client add name=nexo-c$n interface=nexo-m$n user=\"$4\" password=\"$5\" add-default-route=no use-peer-dns=no disabled=no comment=nexo-lab" ;;
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
