#!/usr/bin/env python3
"""Laboratório de provisionamento Huawei — demonstração VERBOSA do ciclo completo por SSH real.

Sobe o emulador de OLT Huawei por SSH de verdade, conecta o nosso driver com escrita habilitada e roda, imprimindo
cada passo e CADA COMANDO que chega ao equipamento (emulado):
  autorizar -> ler (online + sinal) -> desautorizar -> re-autorizar restaurando a MESMA config (cliente volta a navegar).

Prova que não é "laboratório falho": os comandos reais trafegam pelo transporte de verdade e são confirmados. NÃO é
homologação em equipamento físico. Use `./nexo lab-olt`. A mesma prova roda como teste em tests/test_olt_huawei_lab.py.
"""
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paramiko  # noqa: E402

from nexo_agent.drivers import olt_huawei_emulator as emu  # noqa: E402
from nexo_agent.drivers.olt_huawei import HuaweiOltDriver  # noqa: E402
from nexo_agent.ssh_trust import fingerprint, install_key  # noqa: E402

EMU_PRODUCT = "MA5800-X7 (emulado)"
EMU_FIRMWARE = "MA5800V100R019C10 (emulador NexoISP)"
SERIAL = "48575443A1B2C3D4"
CFG = dict(pon_port="0/1/0", line_profile="residencial", service_profile="bridge-1ge", service_vlan=100)


def main():
    state = emu.OltState()
    commands = []
    key = paramiko.RSAKey.generate(2048)
    sock = socket.socket(); sock.bind(("127.0.0.1", 0)); sock.listen(4); sock.settimeout(20)
    port = sock.getsockname()[1]

    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=lambda c=conn: emu.ssh_client(c, state, key, on_command=commands.append), daemon=True).start()
    threading.Thread(target=loop, daemon=True).start()

    tmp = tempfile.mkdtemp()
    kh = str(Path(tmp) / "known_hosts")
    install_key(kh, "127.0.0.1", port, f"ssh-rsa {key.get_base64()}", fingerprint(key), "Chave do emulador de laboratorio conferida nesta prova")
    drv = HuaweiOltDriver.from_device(
        {"host": "127.0.0.1", "api_port": port, "credential_ref": "olt"},
        {"olt": {"username": emu.LAB_USER[0], "password": emu.LAB_USER[1], "known_hosts_file": kh,
                 "allow_writes": True, "expected_product": EMU_PRODUCT, "expected_firmware": EMU_FIRMWARE, "gemport": 1}})

    def banner(t):
        print(f"\n=== {t} ===")

    def mostra_comandos():
        for c in commands:
            if c.startswith(("interface gpon", "ont add", "ont delete", "ont port native-vlan", "service-port", "undo service-port")):
                print(f"   OLT <- {c}")
        commands.clear()

    def mostra_onu(st):
        print(f"   ONU: autorizada={st.authorized} online={st.online} pon={st.pon_port} perfil={st.line_profile}/{st.service_profile} "
              f"vlan={st.service_vlan} rx={st.rx_dbm}dBm tx={st.tx_dbm}dBm versao={st.applied_version}")

    print(f"Emulador Huawei por SSH em 127.0.0.1:{port} — {EMU_PRODUCT} / {EMU_FIRMWARE}")
    chk = drv.check()
    print(f"Identidade lida da OLT: {chk['product']} {chk['firmware']}")

    banner("0. DESCOBERTA (autofind)")
    print("   ONUs aguardando autorizacao:", [o["serial"] for o in drv.discover()])

    banner("1. AUTORIZAR (v1)")
    commands.clear()
    drv.authorize(SERIAL, description="nexo:0a1b2c3d:v1", **CFG)
    mostra_comandos()
    banner("2. LER de volta")
    s1 = drv.read_onu(SERIAL); mostra_onu(s1)

    banner("3. DESAUTORIZAR (undo service-port antes de ont delete)")
    commands.clear()
    print("   resultado:", drv.deauthorize(SERIAL))
    mostra_comandos()
    banner("4. LER apos desautorizar")
    mostra_onu(drv.read_onu(SERIAL))
    print("   de volta ao autofind:", SERIAL in [o["serial"] for o in drv.discover()])

    banner("5. RE-AUTORIZAR (v2) restaurando a MESMA config — cliente volta a navegar")
    commands.clear()
    drv.authorize(SERIAL, description="nexo:0a1b2c3d:v2", **CFG)
    mostra_comandos()
    banner("6. LER restaurado")
    s2 = drv.read_onu(SERIAL); mostra_onu(s2)

    ok = (s2.authorized and s2.online and (s2.pon_port, s2.line_profile, s2.service_vlan) == (s1.pon_port, s1.line_profile, s1.service_vlan)
          and s2.applied_version == 2)
    print("\n=== PROVA DE LABORATORIO:", "OK" if ok else "FALHOU", "===")
    sock.close()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
