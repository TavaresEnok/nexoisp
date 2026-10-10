#!/usr/bin/env bash
# Prova de laboratório do RADIUS local (FreeRADIUS REAL + driver real do agente), sem nuvem e sem NAS.
# Comprova: o driver grava autorização que o FreeRADIUS responde (PAP/CHAP/MS-CHAPv2), perfil no Access-Accept,
# suspensão => Access-Reject, reativação => Access-Accept, tudo com a nuvem ausente.
# NÃO comprova sessão PPPoE real: isso exige o roteiro com CHR/equipamento (docs/lab-pppoe.md).
set -euo pipefail
cd "$(dirname "$0")/.."
NET=nexo-lab-radius; VOL=nexo-lab-radius-data; SECRET=lab-secret-$RANDOM
cleanup() { docker rm -f nexo-lab-radius >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; docker volume rm $VOL >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
docker build -q -t nexo-site-radius infra/site/radius >/dev/null
docker build -q -t nexoisp-agent services/network-agent >/dev/null
docker network create $NET >/dev/null; docker volume create $VOL >/dev/null
docker run -d --name nexo-lab-radius --network $NET -v $VOL:/data -e RADIUS_NAS_SECRET=$SECRET -e RADIUS_NAS_NET=0.0.0.0/0 nexo-site-radius >/dev/null
sleep 3
drv() { docker run --rm -v $VOL:/data nexoisp-agent python -c "
from nexo_agent.drivers.mikrotik_radius import RadiusStore
s = RadiusStore('/data/radius/radius.sqlite')
$1"; }
auth() { # tipo senha -> imprime Access-Accept/Reject e atributos
  docker exec nexo-lab-radius radtest -t "$1" cliente.lab "$2" 127.0.0.1 0 $SECRET 2>&1 | grep -E "Received|Mikrotik-Group|no response" || true; }
expect() { local out; out="$(auth "$2" "$3")"; if echo "$out" | grep -q "$1"; then echo "  ok   $4"; else echo "  FALHA $4 => $out"; FAIL=1; fi; }
FAIL=0
echo "1) provisionar (v1, perfil plano-200m)"
drv "s.apply('cliente.lab', 'Senha-Lab-1', 'plano-200m', 'active', 1); print('   lido:', s.read('cliente.lab'))"
expect "Access-Accept" pap Senha-Lab-1 "PAP aceita"
expect "Access-Accept" chap Senha-Lab-1 "CHAP aceita"
expect "Access-Accept" mschap Senha-Lab-1 "MS-CHAP aceita"
expect "plano-200m" pap Senha-Lab-1 "Access-Accept traz Mikrotik-Group = plano-200m"
expect "Access-Reject" pap senha-errada "senha errada rejeitada"
echo "2) suspender (v2)"
drv "s.apply('cliente.lab', None, 'plano-200m', 'suspended', 2); print('   lido:', s.read('cliente.lab'))"
expect "Access-Reject" pap Senha-Lab-1 "suspenso: PAP rejeitada"
expect "Access-Reject" mschap Senha-Lab-1 "suspenso: MS-CHAP rejeitada"
echo "3) reativar com troca de plano (v3, perfil plano-500m)"
drv "s.apply('cliente.lab', None, 'plano-500m', 'active', 3); print('   lido:', s.read('cliente.lab'))"
expect "Access-Accept" chap Senha-Lab-1 "reativado: CHAP aceita"
expect "plano-500m" pap Senha-Lab-1 "novo perfil no Access-Accept"
echo "4) RADIUS segue respondendo após reinício (agente e nuvem ausentes)"
docker restart nexo-lab-radius >/dev/null; sleep 3
expect "Access-Accept" pap Senha-Lab-1 "após reinício do RADIUS: aceita com dados locais"
echo "versão: $(docker exec nexo-lab-radius freeradius -v | head -1)"
[ $FAIL = 0 ] && echo "RESULTADO: RADIUS local OK (homologação PPPoE em NAS real continua pendente)" || { echo "RESULTADO: FALHOU"; exit 1; }
