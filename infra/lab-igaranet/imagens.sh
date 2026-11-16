#!/usr/bin/env bash
# Monta as imagens Docker dos nós do laboratório IgaraNet no PNETLab (o PNETLab usa o Docker local para nós "docker").
#   igaranet-olt:lab       OLT Huawei EMULADA (CLI MA5800 por SSH) + ponte uplink<->PON que respeita o estado das ONUs
#   igaranet-agente:lab    agente de rede do NexoISP do provedor IgaraNet (certificado mTLS, token e credencial da OLT)
#   igaranet-clientes:lab  30 roteadores de assinante com pppd/PPPoE real
# Segredos (token do agente, chave do certificado, chave SSH da OLT) ficam só nas imagens locais e em
# ~/.local/share/nexoisp/igaranet — nunca no repositório. Pré-requisito: `provisionar.py base` já rodado.
# O Docker deste servidor (PNETLab) não aceita seccomp no build: imagens com apt são montadas por container + commit.
# No commit, `ENTRYPOINT []` não limpa o entrypoint do container de montagem: o comando do nó vai no próprio ENTRYPOINT.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(cd ../.. && pwd)
D="sudo docker"
S=~/.local/share/nexoisp/igaranet
B=$S/build
CA=~/.local/share/nexoisp/painel-20261106/certs
mkdir -p "$B" && chmod 700 "$B"
TAG=$(date +%s)

monta() {  # $1 imagem base, $2 imagem final, $3 comando de instalação (como root, com internet), demais: --change
  local base=$1 final=$2 cmd=$3; shift 3
  local n="igaranet-build-$TAG-${final%%:*}"
  $D run --name "$n" --network host --security-opt seccomp=unconfined -u root --entrypoint sh "$base" -c "$cmd"
  $D commit "$@" "$n" "$final" >/dev/null
  echo "imagem $final pronta"
}

echo "== agente do NexoISP (código atual do repositório)"
# O `docker build` do Dockerfile do agente falha neste Docker (apt sob seccomp). Parte da imagem nexoisp-agent já
# existente e sobrepõe o código atual do repositório (mesmas dependências: requirements.txt sem mudança de versão).
$D create --name "igaranet-agent-code-$TAG" nexoisp-agent:latest >/dev/null
$D cp "$REPO/services/network-agent/nexo_agent/." "igaranet-agent-code-$TAG:/agent/nexo_agent/"
$D commit "igaranet-agent-code-$TAG" nexoisp-agent:igaranet >/dev/null

echo "== chave SSH da OLT emulada (gerada uma vez; o agente confere a impressão digital)"
if [ ! -f "$B/olt_host_key" ]; then
  $D run --rm --security-opt seccomp=unconfined -u root -v "$B:/out" --entrypoint python nexoisp-agent:igaranet -c \
    "import paramiko;k=paramiko.RSAKey.generate(2048);k.write_private_key_file('/out/olt_host_key');open('/out/olt_host_key.pub','w').write('ssh-rsa '+k.get_base64())"
  sudo chown "$(id -u):$(id -g)" "$B"/olt_host_key*; chmod 600 "$B/olt_host_key"
fi

echo "== dados dos clientes"
python3 - "$B" <<'EOF'
import json, sys
cl = json.load(open("clientes.json"))
open(f"{sys.argv[1]}/clientes.tsv", "w").write("".join(f"{c['n']}\t{c['login']}\t{c['senha']}\t{c['mac']}\t{c['nome']}\t{c['bairro']}\n" for c in cl))
EOF

echo "== OLT"
$D create --name "igaranet-olt-src-$TAG" nexoisp-agent:igaranet >/dev/null
$D cp olt/olt_node.py "igaranet-olt-src-$TAG:/agent/olt_node.py"
$D cp clientes.json "igaranet-olt-src-$TAG:/agent/clientes.json"
$D cp "$B/olt_host_key" "igaranet-olt-src-$TAG:/agent/olt_host_key"
$D commit "igaranet-olt-src-$TAG" igaranet-olt:src >/dev/null
monta igaranet-olt:src igaranet-olt:lab \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nftables iproute2 >/dev/null &&
   mkdir -p /lab /state && mv /agent/olt_node.py /agent/clientes.json /lab/ && mv /agent/olt_host_key /state/host_key && chmod 600 /state/host_key' \
  --change 'USER root' --change 'WORKDIR /lab' --change 'ENTRYPOINT ["python", "/lab/olt_node.py"]' --change 'CMD []'

echo "== agente IgaraNet (certificado, token, credencial da OLT)"
python3 - "$S" "$B" <<'EOF'
import json, sys
st = json.load(open(f"{sys.argv[1]}/estado.json"))
b = sys.argv[2]
open(f"{b}/agent.env", "w").write(f"NEXO_API_URL=https://10.0.137.254:18443\nNEXO_AGENT_TOKEN={st['agent_token']}\n")
json.dump({"_comentario": "Laboratório IgaraNet: OLT Huawei EMULADA no PNETLab (não é equipamento real).",
           "olt-igarassu": {"username": "emu", "password": "emu-lab", "transport": "ssh", "known_hosts_file": "/config/known_hosts",
                            "allow_writes": True, "expected_product": "MA5800-X7 (emulado)",
                            "expected_firmware": "MA5800V100R019C10 (emulador NexoISP)", "gemport": 1}},
          open(f"{b}/credentials.json", "w"), indent=1, ensure_ascii=False)
open(f"{b}/agent_id", "w").write(st["agent_id"])
EOF
AID=$(cat "$B/agent_id")
if [ ! -f "$B/agent.crt" ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=agent:$AID" -keyout "$B/agent.key" -out "$B/agent.csr" 2>/dev/null
  openssl x509 -req -in "$B/agent.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial -days 398 -out "$B/agent.crt" \
    -extfile <(printf "extendedKeyUsage=clientAuth") 2>/dev/null
  chmod 600 "$B/agent.key"
fi
cp "$CA/ca.crt" "$B/ca.crt"
cat > "$B/agente.sh" <<'EOF'
#!/bin/sh
# Nó AGENTE do IgaraNet: rede de gerência (eth1, nuvem NAT do PNETLab) e o agente do NexoISP como usuário sem privilégio.
for i in $(seq 300); do [ -e /sys/class/net/eth1 ] && break; sleep 1; done
ip addr flush dev eth1; ip addr add 10.0.137.4/24 dev eth1; ip link set eth1 up
ip route replace default via 10.0.137.254 dev eth1
set -a; . /config/agent.env; set +a
exec setpriv --reuid=10001 --regid=10001 --init-groups env HOME=/home/agent python -m nexo_agent
EOF
$D create --name "igaranet-agente-src-$TAG" nexoisp-agent:igaranet >/dev/null
$D cp "$B/agente.sh" "igaranet-agente-src-$TAG:/agent/agente.sh"
for f in agent.crt agent.key ca.crt agent.env credentials.json olt_host_key.pub; do $D cp "$B/$f" "igaranet-agente-src-$TAG:/agent/$f"; done
$D commit "igaranet-agente-src-$TAG" igaranet-agente:src >/dev/null
monta igaranet-agente:src igaranet-agente:lab \
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends iproute2 >/dev/null &&
   mkdir -p /certs /config && mv /agent/agent.crt /agent/agent.key /agent/ca.crt /certs/ && mv /agent/agent.env /agent/credentials.json /config/ &&
   chown -R agent /certs /config /data && chmod 700 /certs /config && chmod 600 /certs/agent.key /config/agent.env /config/credentials.json && chmod 644 /certs/agent.crt /certs/ca.crt &&
   cd /agent && setpriv --reuid=10001 --regid=10001 --init-groups python -m nexo_agent.ssh_trust --known-hosts /config/known_hosts --host 10.0.137.3 --port 22 \
     --public-key "$(cat /agent/olt_host_key.pub)" \
     --fingerprint "$(python -c "import base64,hashlib;k=open(\"/agent/olt_host_key.pub\").read().split()[1];print(\"SHA256:\"+base64.b64encode(hashlib.sha256(base64.b64decode(k)).digest()).decode().rstrip(\"=\"))")" \
     --reason "OLT emulada do laboratório IgaraNet; chave gerada por imagens.sh" && chmod +x /agent/agente.sh' \
  --change 'USER root' --change 'ENV NEXO_AGENT_TLS_DIR=/certs NEXO_AGENT_CREDENTIALS=/config/credentials.json NEXO_AGENT_DATA=/data' \
  --change 'ENTRYPOINT ["/agent/agente.sh"]' --change 'CMD []'

echo "== clientes"
$D create --name "igaranet-cli-src-$TAG" radlab-pppoe:1 true >/dev/null
$D cp clientes/clientes_node.sh "igaranet-cli-src-$TAG:/usr/local/bin/clientes_node.sh"
$D cp clientes/clientes "igaranet-cli-src-$TAG:/usr/local/bin/clientes"
$D cp "$B/clientes.tsv" "igaranet-cli-src-$TAG:/clientes.tsv"
$D commit "igaranet-cli-src-$TAG" igaranet-clientes:src >/dev/null
monta igaranet-clientes:src igaranet-clientes:lab \
  'mkdir -p /lab && mv /clientes.tsv /lab/ && chmod 600 /lab/clientes.tsv && chmod +x /usr/local/bin/clientes_node.sh /usr/local/bin/clientes' \
  --change 'USER root' --change 'ENTRYPOINT ["/bin/bash", "/usr/local/bin/clientes_node.sh"]' --change 'CMD []'
echo "imagens prontas"
