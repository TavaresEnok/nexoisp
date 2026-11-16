#!/usr/bin/env python3
"""Nó "OLT Huawei" do laboratório IgaraNet no PNETLab (EMULADOR — não é equipamento nem software da Huawei).

Interfaces que o PNETLab entrega ao container:
  eth1  uplink para o concentrador MikroTik (porta de serviço da OLT)
  eth2  rede PON: do outro lado estão as ONUs/roteadores dos 30 clientes
  eth3  gerência (nuvem NAT do PNETLab): o agente do NexoISP entra por SSH aqui

O tráfego dos clientes atravessa de verdade este nó (ponte eth1<->eth2). Uma regra de ponte (nftables) só deixa passar o
MAC do roteador de um cliente quando a ONU dele está AUTORIZADA e ONLINE no estado do emulador. Assim:
  - ONU ainda não autorizada pelo NexoISP  -> cliente não conecta (como numa PON real);
  - "reiniciar ONU" pelo NexoISP            -> o cliente fica sem enlace durante o reinício e a sessão PPPoE cai;
  - desautorizar / remover ONU              -> o cliente perde o serviço.
"""
import json
import os
import subprocess
import sys
import threading
import time

sys.path.insert(0, "/agent")   # código do agente do NexoISP (imagem base)
from nexo_agent.drivers import olt_huawei_emulator as emu  # noqa: E402

STATE = "/state/olt-state.json"
CLIENTES = "/lab/clientes.json"
MGMT_IP = os.environ.get("OLT_MGMT_IP", "10.0.137.3/24")
MGMT_GW = os.environ.get("OLT_MGMT_GW", "10.0.137.254")


def sh(cmd: str, check: bool = False) -> int:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{cmd}: {r.stderr.strip()}")
    return r.returncode


def wait_ifaces(names, timeout=300):
    """O PNETLab move as interfaces para dentro do container alguns segundos depois de iniciá-lo."""
    end = time.time() + timeout
    while time.time() < end:
        if all(os.path.exists(f"/sys/class/net/{n}") for n in names):
            return
        time.sleep(1)
    print(f"aviso: interfaces ausentes: {[n for n in names if not os.path.exists('/sys/class/net/' + n)]}", flush=True)


def setup_network():
    wait_ifaces(["eth1", "eth2", "eth3"])
    sh("ip link add br-pon type bridge 2>/dev/null; ip link set br-pon type bridge stp_state 0")
    for i in ("eth1", "eth2"):
        sh(f"ip link set {i} master br-pon; ip link set {i} up")
    sh("ip link set br-pon up")
    sh(f"ip addr flush dev eth3; ip addr add {MGMT_IP} dev eth3; ip link set eth3 up")
    sh(f"ip route replace default via {MGMT_GW} dev eth3")
    # Tabela própria na família bridge: descarta quadros de/para MAC de cliente cuja ONU não está apta.
    sh("nft add table bridge pon", check=True)
    sh("nft add set bridge pon liberados '{ type ether_addr; }'; nft add set bridge pon clientes '{ type ether_addr; }'")
    # ("fwd" é palavra reservada do nftables: a cadeia se chama "encaminha")
    sh("nft add chain bridge pon encaminha '{ type filter hook forward priority 0; policy accept; }'", check=True)
    sh("nft flush chain bridge pon encaminha", check=True)
    sh("nft add rule bridge pon encaminha ether saddr @clientes ether saddr != @liberados counter drop", check=True)
    sh("nft add rule bridge pon encaminha ether daddr @clientes ether daddr != @liberados counter drop", check=True)


def seed_state():
    """Primeira subida: as 30 ONUs aparecem na descoberta (autofind) da PON, aguardando o NexoISP autorizar."""
    clientes = json.load(open(CLIENTES))
    if os.path.exists(STATE):
        return
    d = {"autofind": [[c["pon"], c["serial"], "HWTC", "EG8145V5" if c["n"] % 3 else "HG8310M"] for c in clientes],
         "onts": [], "sports": [], "next_sp": 10, "offline": [], "rebooting": {}, "reboot_s": 75,
         "line_profiles": ["residencial", "residencial-200", "residencial-500"], "srv_profiles": ["bridge-1ge", "router-4ge"],
         "vlans": [100, 120, 200], "rx": {c["serial"]: c["rx_dbm"] for c in clientes}}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(d, open(STATE, "w"))


_last = None
_lock = threading.Lock()


def sync(state: "emu.OltState"):
    """Aplica na ponte o estado do emulador: libera só MACs de ONUs autorizadas e online. Também aplica a potência
    configurada por cliente às ONUs recém-autorizadas."""
    global _last
    clientes = json.load(open(CLIENTES))
    by_sn = {c["serial"]: c for c in clientes}
    with _lock:
        d = state.d
        for o in d["onts"]:
            if "rx_base" not in o and o["sn"] in d.get("rx", {}):
                o["rx_base"] = d["rx"][o["sn"]]
        ok = sorted(by_sn[o["sn"]]["mac"] for o in d["onts"] if o["sn"] in by_sn and state.is_online(o["sn"]))
        if ok == _last:
            return
        allmacs = ", ".join(c["mac"] for c in clientes)
        cmd = f"nft flush set bridge pon clientes; nft add element bridge pon clientes '{{ {allmacs} }}'; nft flush set bridge pon liberados"
        if ok:
            cmd += f"; nft add element bridge pon liberados '{{ {', '.join(ok)} }}'"
        if sh(cmd) == 0:
            print(f"{time.strftime('%H:%M:%S')} PON: {len(ok)}/{len(clientes)} ONUs com tráfego liberado", flush=True)
            _last = ok


def ticker(state):
    """Fim do reinício de uma ONU acontece por tempo, sem comando: reavalia a cada 2 s."""
    while True:
        time.sleep(2)
        with state.lock:
            sync(state)


def main():
    setup_network()
    seed_state()
    state = emu.OltState(STATE)
    state.listener = sync
    sync(state)
    threading.Thread(target=emu.serve, args=(22, STATE, "ssh", state), daemon=True).start()
    ticker(state)


if __name__ == "__main__":
    main()
