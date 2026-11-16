#!/usr/bin/env bash
# Laboratório IgaraNet no PNETLab (página própria; não toca nos labs Trio e FlashNet).
#   igaranet.sh imagens    monta as imagens Docker dos nós (ver imagens.sh)
#   igaranet.sh lab        instala/atualiza a página IgaraNet.unl no PNETLab
#   igaranet.sh iniciar    cria a sessão do lab (como a interface web faz) e liga os 4 nós
#   igaranet.sh parar      desliga os nós
#   igaranet.sh limpar     apaga os containers dos nós Docker (recriados da imagem ao iniciar)
#   igaranet.sh status     estado dos nós e portas de console
#   igaranet.sh chr        aplica a configuração do concentrador MikroTik pelo console (túnel, RADIUS, PPPoE)
#   igaranet.sh clientes   resumo das sessões PPPoE vistas no nó dos clientes
set -euo pipefail
cd "$(dirname "$0")"
LABDIR=/opt/unetlab/labs
LAB=IgaraNet.unl
POD=${PNET_POD:-43}            # pod do usuário admin do PNETLab
WRAP=/opt/unetlab/wrappers/unl_wrapper

religar() {  # recriar um nó Docker pode recriar a ponte e soltar a placa do MikroTik: confere e religa (ether2 -> uplink)
  local S=$1
  local chr; chr=$(sudo mysql -N pnetlab_db -e "SELECT node_session_id FROM node_sessions WHERE node_session_lab=$S AND node_session_nid=1")
  if [ -n "$chr" ] && [ -e "/sys/class/net/vunl${chr}_1" ] && [ ! -e "/sys/class/net/vnet${S}_2/brif/vunl${chr}_1" ]; then
    sudo ip link set "vunl${chr}_1" master "vnet${S}_2" && echo "placa ether2 do MikroTik religada à ponte do uplink"
  fi
}

sessao() {  # id da sessão do lab (cria na primeira vez, pelas funções do próprio PNETLab)
  sudo php -r '
    require_once("/opt/unetlab/html/includes/init.php");
    $lid = (string) simplexml_load_file("/opt/unetlab/labs/IgaraNet.unl")["id"];
    $r = addLabSession($lid, (int) $argv[1], "/IgaraNet.unl");
    if (!$r["result"]) { fwrite(STDERR, $r["message"]); exit(1); }
    $db = checkDatabase();
    $st = $db->prepare("SELECT lab_session_id FROM lab_sessions WHERE lab_session_lid=? AND lab_session_pod=?");
    $st->execute([$lid, (int) $argv[1]]);
    $id = $st->fetchColumn();
    new Lab("/opt/unetlab/labs/IgaraNet.unl", (int) $argv[1], (int) $id);   // cria as sessões dos nós e interfaces
    echo $id;' "$POD" 2>/dev/null | tail -1
}

case "${1:-status}" in
  imagens) ./imagens.sh ;;
  lab)
    sudo install -o www-data -g www-data -m 644 "$LAB" "$LABDIR/$LAB"
    echo "página $LABDIR/$LAB instalada" ;;
  iniciar)
    # O painel publica o canal dos agentes no endereço da nuvem NAT (10.0.137.254); se o painel subiu antes da nuvem
    # existir (reinício do servidor), a porta fica sem escuta: recria os serviços do painel.
    if ! sudo ss -ltn | grep -q "10.0.137.254:18443"; then
      sudo docker compose -p nexoisp-painel -f ~/.local/share/nexoisp/painel-20261106/compose.yaml up -d --force-recreate api vpn radius
    fi
    S=$(sessao); echo "sessão do lab: $S"
    for n in 1 2 3 4; do
      sudo "$WRAP" -a start -T "$POD" -S "$S" -D "$n" -F "$LABDIR/$LAB" 2>>/tmp/igaranet-wrapper.log && echo "nó $n iniciado" || echo "nó $n: falha (ver /opt/unetlab/data/Logs/unl_wrapper.txt)"
    done
    religar "$S" ;;
  limpar)   # apaga os containers dos nós Docker (o PNETLab os recria da imagem na próxima subida)
    S=$(sessao)
    for n in 2 3 4; do sudo "$WRAP" -a wipe -T "$POD" -S "$S" -D "$n" -F "$LABDIR/$LAB" 2>/dev/null && echo "nó $n limpo"; done ;;
  parar)
    S=$(sessao)
    for n in 4 3 2 1; do sudo "$WRAP" -a stop -T "$POD" -S "$S" -D "$n" -F "$LABDIR/$LAB" 2>/dev/null && echo "nó $n parado"; done ;;
  status)
    S=$(sessao)
    sudo mysql pnetlab_db -e "SELECT node_session_nid AS no, node_session_type AS tipo, node_session_port AS console, node_session_running AS ligado FROM node_sessions WHERE node_session_lab=$S ORDER BY 1" ;;
  chr) python3 chr_config.py ;;
  clientes)
    S=$(sessao); ID=$(sudo mysql -N pnetlab_db -e "SELECT node_session_id FROM node_sessions WHERE node_session_lab=$S AND node_session_nid=4")
    sudo docker -H tcp://127.0.0.1:4243 exec "docker$ID" clientes status ;;
  *) sed -n 2,10p "$0" ;;
esac
