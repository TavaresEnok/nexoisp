#!/bin/sh
# Clientes PPPoE reais (pppd + plugin PPPoE) no segmento dos assinantes. Cada índice é um "CPE" com MAC próprio.
#   pppoe-client.sh up <usuario> <senha> [segundos] [indice]  -> disca (persistente) e espera a sessão subir
#   pppoe-client.sh once <usuario> <senha>                    -> uma tentativa; imprime o motivo se falhar
#   pppoe-client.sh down [indice|all] | status [indice] | log [indice]
PLUGIN=$(ls /usr/lib/pppd/*/rp-pppoe.so /usr/lib/pppd/*/pppoe.so 2>/dev/null | head -1)
idx() { echo "${1:-0}"; }
ifc() { [ "$1" = 0 ] && echo tap0 || echo "cpe$1"; }
opts() { echo "plugin $PLUGIN $(ifc "$1") noauth nodefaultroute noipdefault hide-password lcp-echo-interval 5 lcp-echo-failure 3 mtu 1480 mru 1480 unit $1 linkname c$1"; }
stop() { pkill -f "unit $1 linkname c$1( |$)" 2>/dev/null; sleep 1; }  # o pidfile só existe com o enlace no ar; mata pelo padrão
st() { if ip -4 addr show "ppp$1" 2>/dev/null | grep -q inet; then echo "ONLINE $(ip -4 -o addr show ppp$1 | awk '{print $4" peer "$6}')"; else echo "OFFLINE"; fi; }
case "$1" in
  up)   i=$(idx "$5"); stop "$i"
        if [ "$i" != 0 ] && ! ip link show "cpe$i" >/dev/null 2>&1; then ip link add link tap0 name "cpe$i" type macvlan mode bridge && ip link set "cpe$i" up; fi
        : > "/var/log/pppd-$i.log"
        pppd $(opts "$i") user "$2" password "$3" persist holdoff 3 maxfail 0 logfile "/var/log/pppd-$i.log"
        n=0; while [ $n -lt "${4:-25}" ]; do ip -4 addr show "ppp$i" 2>/dev/null | grep -q inet && break; n=$((n+1)); sleep 1; done; st "$i" ;;
  once) stop 0
        timeout 25 pppd $(opts 0) user "$2" password "$3" nodetach maxfail 1 2>&1 | grep -iE "auth|fail|succe|local  IP|remote IP|terminat|timeout" | head -12 ;;
  down) if [ "$2" = all ]; then pkill pppd 2>/dev/null; sleep 2; else stop "$(idx "$2")"; sleep 1; fi; echo "parado" ;;
  status) st "$(idx "$2")" ;;
  log)  tail -${3:-12} "/var/log/pppd-$(idx "$2").log" ;;
esac
