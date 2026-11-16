#!/bin/bash
# Nó "CLIENTES" do laboratório IgaraNet no PNETLab: 30 roteadores de assinante FICTÍCIOS atrás das ONUs.
# Cada cliente = interface macvlan com o MAC do roteador dele na rede PON (eth1) + pppd/PPPoE real com o login do NexoISP.
# O pppd fica em "persist": se a sessão cair (reinício da ONU, bloqueio, desconexão pelo NexoISP), ele redisca sozinho,
# como um roteador de verdade. Uso dentro do nó: `clientes status`, `clientes log 7`, `clientes reiniciar 7`.
set -u

for _ in $(seq 300); do [ -e /sys/class/net/eth1 ] && break; sleep 1; done
ip link set eth1 up

disca() {  # $1 = número do cliente; /lab/clientes.tsv: n login senha mac nome bairro
  local n=$1 login senha mac
  read -r login senha mac < <(awk -F'\t' -v n="$n" '$1==n {print $2, $3, $4}' /lab/clientes.tsv)
  ip link show "cpe$n" >/dev/null 2>&1 || ip link add link eth1 name "cpe$n" address "$mac" type macvlan mode private
  ip link set "cpe$n" up
  # holdoff 15 / maxfail 0: tenta para sempre, como o roteador do cliente; lcp-echo derruba a sessão em ~30 s sem enlace
  pppd plugin rp-pppoe.so "cpe$n" user "$login" password "$senha" noauth nodefaultroute noipdefault hide-password \
       lcp-echo-interval 10 lcp-echo-failure 3 mtu 1480 mru 1480 unit "$n" linkname "c$n" logfile "/var/log/pppd-$n.log" \
       holdoff 15 maxfail 0 persist >/dev/null 2>&1
}

for n in $(seq 1 30); do disca "$n"; sleep 0.3; done
echo "30 clientes PPPoE iniciados (reconexão automática)"

# Uso leve e variado de cada cliente (pings grandes até o concentrador), para o consumo aparecer no NexoISP.
uso() {
  while true; do
    for n in $(seq 1 30); do
      ip -o -4 addr show dev "ppp$n" >/dev/null 2>&1 || continue
      ping -q -I "ppp$n" -s 1400 -i 0.2 -c $(( (n % 7 + 1) * 20 )) 100.64.10.1 >/dev/null 2>&1 &
    done
    wait
    sleep 60
  done
}
uso &
# Mantém o container vivo e regista um resumo a cada minuto (visível no console do nó).
while true; do
  sleep 60
  echo "$(date +%H:%M:%S) sessões PPPoE ativas: $(ip -o link show | grep -c ': ppp')/30"
done
