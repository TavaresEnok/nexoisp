"""EMULADOR da CLI Huawei SmartAX — escrito por nós a partir de guias públicos, SOMENTE para desenvolvimento e testes.
Não é software da Huawei e não reproduz o firmware: serve para exercitar o driver sem equipamento. Passar aqui NÃO é homologação.

Uso como servidor de laboratório:  python -m nexo_agent.drivers.olt_huawei_emulator <porta> <arquivo_de_estado.json> [ssh|ssh-legacy|telnet]"""
import json
import os
import re
import threading
import time

LINE = "  -----------------------------------------------------------------------------"
SEED_AUTOFIND = [("0/1/0", "48575443A1B2C3D4", "HWTC", "HG8310M"), ("0/1/0", "485754430000BEEF", "HWTC", "EG8145V5"),
                 ("0/1/3", "5A544547C0FFEE01", "ZTEG", "F601")]


class OltState:
    """Estado da OLT emulada (compartilhado entre sessões). Persistido em arquivo quando informado."""

    def __init__(self, path: str | None = None):
        self.path, self.lock = path, threading.Lock()
        self.d = {"autofind": [list(x) for x in SEED_AUTOFIND], "onts": [], "sports": [], "next_sp": 10, "offline": [],
                  "line_profiles": ["residencial", "residencial-200", "residencial-500"], "srv_profiles": ["bridge-1ge", "router-4ge"], "vlans": [100, 120, 200]}
        if path and os.path.exists(path):
            self.d = json.load(open(path))

    def save(self):
        if self.path:
            json.dump(self.d, open(self.path, "w"))


class HuaweiCliEmulator:
    """Uma sessão de CLI. Implementa só os comandos que o driver usa, com as mensagens de falha usuais."""

    def __init__(self, state: OltState, hostname: str = "MA5800-EMU"):
        self.s, self.host, self.mode, self.fs = state, hostname, "config", None
        self.log: list[str] = []

    def prompt(self) -> str:
        return {"user": f"{self.host}>", "enable": f"{self.host}#", "config": f"{self.host}(config)#"}.get(self.mode, f"{self.host}(config-if-gpon-{self.fs})#")

    def close(self) -> None:
        pass

    def run(self, command: str) -> str:
        with self.s.lock:
            self.log.append(command)
            out = self._run(command.strip())
            self.s.save()
            return out

    # ---- comandos ----
    def _run(self, c: str) -> str:
        d = self.s.d
        if c in ("", "undo smart", "undo interactive") or c.startswith("scroll"):
            return ""
        if c == "enable":
            self.mode = "enable"; return ""
        if c == "config":
            self.mode = "config"; return ""
        if c == "quit":
            self.mode = {"if": "config", "config": "enable", "enable": "user"}.get(self.mode, "user"); return ""
        if c == "display ntp-service status":
            status = "synchronized" if d.get("ntp", True) else "unsynchronized"
            return f" clock status: {status}\n clock stratum: 3\n reference clock ID: 192.0.2.123"
        if c == "display current-configuration":
            return self._current_configuration()
        if c == "display version":
            return "\n  VERSION : MA5800V100R019C10 (emulador NexoISP)\n  PATCH   : -\n  PRODUCT : MA5800-X7 (emulado)\n"
        if c == "display ont autofind all":
            if not d["autofind"]:
                return "  Failure: The automatically found ONTs do not exist"
            blocks = []
            for i, (fsp, sn, vend, model) in enumerate(d["autofind"], 1):
                blocks.append(f"   {'-' * 76}\n   Number              : {i}\n   F/S/P               : {fsp}\n   Ont SN              : {sn} ({vend}-{sn[8:]})\n"
                              f"   Password            : 0x00000000000000000000\n   Loid                : \n   VendorID            : {vend}\n"
                              f"   Ont Version         : 1A2B.C\n   Ont SoftwareVersion : V5R019C00S100\n   Ont EquipmentID     : {model}\n   Ont autofind time   : 2026-10-10 05:00:00-03:00")
            return "\n".join(blocks) + f"\n   {'-' * 76}\n   The number of GPON autofind ONT is {len(d['autofind'])}\n"
        m = re.fullmatch(r"display ont info by-sn (\S+)", c)
        if m:
            o = next((x for x in d["onts"] if x["sn"] == m.group(1).upper()), None)
            if not o:
                return "  Failure: The required ONT does not exist"
            online = o["sn"] not in d["offline"]
            return (f"{LINE}\n  F/S/P                   : {o['fsp']}\n  ONT-ID                  : {o['id']}\n  Control flag            : active\n"
                    f"  Run state               : {'online' if online else 'offline'}\n  Config state            : {'normal' if online else 'initial'}\n  Match state             : {'match' if online else 'initial'}\n"
                    f"  DBA type                : SR\n  ONT distance(m)         : {1200 + o['id'] * 37 if online else '-'}\n  Authentic type          : SN-auth\n  SN                      : {o['sn']} ({bytes.fromhex(o['sn'][:8]).decode('ascii', 'ignore')}-{o['sn'][8:]})\n"
                    f"  Management mode         : OMCI\n  Description             : {o['desc']}\n  Last down cause         : {'-' if online else 'dying-gasp'}\n"
                    f"  Last up time            : 2026-10-10 05:00:10-03:00\n{LINE}\n  Line profile ID      : 10\n  Line profile name    : {o['line']}\n{LINE}\n"
                    f"  Service profile ID   : 10\n  Service profile name : {o['srv']}\n{LINE}\n")
        m = re.fullmatch(r"display service-port port (\d+/\d+/\d+) ont (\d+)", c)
        if m:
            rows = [x for x in d["sports"] if x["fsp"] == m.group(1) and x["ont"] == int(m.group(2))]
            if not rows:
                return "  Failure: No service virtual port can be operated"
            f, s_, p = m.group(1).split("/")
            body = "\n".join(f"  {x['index']:>6} {x['vlan']:>4} common   gpon {f}/{s_} /{p:<2} {x['ont']:<4} {x['gem']:<5} vlan  {x['vlan']:<10} -    -    up" for x in rows)
            return (f"  Switch-Oriented Flow List\n{LINE}\n   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE\n         ID   ATTR     TYPE                    TYPE  PARA\n"
                    f"{LINE}\n{body}\n{LINE}\n   Total : {len(rows)}  (Up/Down :    {len(rows)}/0)\n")
        m = re.fullmatch(r"interface gpon (\d+/\d+)", c)
        if m and self.mode == "config":
            self.mode, self.fs = "if", m.group(1); return ""
        m = re.fullmatch(r'ont add (\d+) sn-auth "?([0-9A-Fa-f]{16})"? omci ont-lineprofile-name "?([^" ]+)"? ont-srvprofile-name "?([^" ]+)"? desc "?([^"]*)"?', c)
        if m and self.mode == "if":
            port, sn, line, srv, desc = m.group(1), m.group(2).upper(), m.group(3), m.group(4), m.group(5)
            fsp = f"{self.fs}/{port}"
            if any(x["sn"] == sn for x in d["onts"]):
                return "  Failure: SN already exists"
            if line not in d["line_profiles"]:
                return "  Failure: The line profile does not exist"
            if srv not in d["srv_profiles"]:
                return "  Failure: The service profile does not exist"
            used = {x["id"] for x in d["onts"] if x["fsp"] == fsp}
            free = [i for i in range(128) if i not in used]
            if not free:  # PON cheia: há PONs reais com 128 ONTs
                return "  Failure: The number of ONTs on the port has reached the upper limit"
            oid = free[0]
            d["onts"].append({"fsp": fsp, "id": oid, "sn": sn, "line": line, "srv": srv, "desc": desc, "at": time.time()})
            d["autofind"] = [x for x in d["autofind"] if x[1] != sn]
            return f"  Number of ONTs that can be added: 1, success: 1\n  PortID :{port}, ONTID :{oid}\n"
        m = re.fullmatch(r"ont tr069-server-config (\d+) (\d+) profile-id (\d+)", c)
        if m and self.mode == "if":
            o = next((x for x in d["onts"] if x["fsp"] == f"{self.fs}/{m.group(1)}" and x["id"] == int(m.group(2))), None)
            if o is None:
                return "  Failure: The ONT does not exist"
            o["tr069"] = int(m.group(3))
            return ""
        m = re.fullmatch(r"ont port native-vlan (\d+) (\d+) eth (\d+) vlan (\d+) priority 0", c)
        if m and self.mode == "if":
            fsp, oid = f"{self.fs}/{m.group(1)}", int(m.group(2))
            o = next((x for x in d["onts"] if x["fsp"] == fsp and x["id"] == oid), None)
            if o is None:
                return "  Failure: The ONT does not exist"
            o.setdefault("native", {})[int(m.group(3))] = int(m.group(4))
            return ""
        m = re.fullmatch(r"ont delete (\d+) (\d+)", c)
        if m and self.mode == "if":
            fsp, oid = f"{self.fs}/{m.group(1)}", int(m.group(2))
            o = next((x for x in d["onts"] if x["fsp"] == fsp and x["id"] == oid), None)
            if not o:
                return "  Failure: The ONT does not exist"
            if any(x["fsp"] == fsp and x["ont"] == oid for x in d["sports"]):
                return "  Failure: This configured object has some service virtual ports"
            d["onts"].remove(o)
            if o["sn"] not in d["offline"]:
                d["autofind"].append([fsp, o["sn"], bytes.fromhex(o["sn"][:8]).decode("ascii", "replace"), "ONT emulada"])
            return "  Number of ONTs that can be deleted: 1, success: 1\n"
        m = re.fullmatch(r"display ont optical-info (\d+) (\d+)", c)
        if m and self.mode == "if":
            o = next((x for x in d["onts"] if x["fsp"] == f"{self.fs}/{m.group(1)}" and x["id"] == int(m.group(2))), None)
            if not o:
                return "  Failure: The ONT does not exist"
            if o["sn"] in d["offline"]:
                return "  Failure: The ONT is not online"
            k = int(o["sn"][-4:], 16) % 800 / 100
            return (f"{LINE}\n  ONU NNI port ID                        : 0\n  Module type                            : GPON\n  Module sub-type                        : CLASS B+\n"
                    f"  Optical power precision(dBm)           : 3.0\n  Rx optical power(dBm)                  : {-17 - k:.2f}\n  Tx optical power(dBm)                  : {2 + k / 10:.2f}\n"
                    f"  Laser bias current(mA)                 : 12\n  Temperature(C)                         : 44\n  Voltage(V)                             : 3.300\n"
                    f"  OLT Rx ONT optical power(dBm)          : {-18 - k:.2f}\n{LINE}\n")
        m = re.fullmatch(r"service-port vlan (\d+) gpon (\d+/\d+/\d+) ont (\d+) gemport (\d+) multi-service user-vlan (\d+) tag-transform translate", c)
        if m and self.mode == "config":
            vlan, fsp, oid, gem, uvlan = int(m.group(1)), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5))
            if vlan not in d["vlans"]:
                return "  Failure: VLAN does not exist"
            if not any(x["fsp"] == fsp and x["id"] == oid for x in d["onts"]):
                return "  Failure: The ONT does not exist"
            if any(x["fsp"] == fsp and x["ont"] == oid and x["vlan"] == vlan for x in d["sports"]):
                return "  Failure: Service virtual port has existed already"
            d["sports"].append({"index": d["next_sp"], "vlan": vlan, "fsp": fsp, "ont": oid, "gem": gem, "user_vlan": uvlan}); d["next_sp"] += 1
            return ""
        m = re.fullmatch(r"undo service-port (\d+)", c)
        if m and self.mode == "config":
            n = len(d["sports"]); d["sports"] = [x for x in d["sports"] if x["index"] != int(m.group(1))]
            return "" if len(d["sports"]) < n else "  Failure: Service virtual port does not exist"
        return "                    ^\n  % Unknown command, the error locates at '^'"

    def _current_configuration(self) -> str:
        """Configuração em execução, no formato da MA5800, montada do estado emulado (backup de configuração)."""
        d = self.s.d
        out = ["[MA5800V100R019: 8211]", "#", "[global-config]", " <global-config>", f" sysname {self.host}",
               " ntp-service unicast-server 192.0.2.123" if d.get("ntp", True) else " undo ntp-service enable", "#", "[vlan-config]", " <vlan-config>"]
        out += [f" vlan {v} smart" for v in d["vlans"]]
        out += ["#", "[gpon]", " <gpon>"]
        for i, name in enumerate(d["line_profiles"], 1):
            out += [f' ont-lineprofile gpon profile-id {i} profile-name "{name}"', "  commit", "  quit"]
        for i, name in enumerate(d["srv_profiles"], 1):
            out += [f' ont-srvprofile gpon profile-id {i} profile-name "{name}"', "  commit", "  quit"]
        for fsp in sorted({o["fsp"] for o in d["onts"]}):
            frame, slot, port = fsp.split("/")
            out += ["#", f"[gpon-{frame}/{slot}]", f" interface gpon {frame}/{slot}"]
            for o in sorted((x for x in d["onts"] if x["fsp"] == fsp), key=lambda x: x["id"]):
                out.append(f'  ont add {port} {o["id"]} sn-auth "{o["sn"]}" omci ont-lineprofile-name "{o["line"]}" ont-srvprofile-name "{o["srv"]}" desc "{o["desc"]}"')
        out += ["#", "[service-port]", " <service-port>"]
        for sp in sorted(d["sports"], key=lambda x: x["index"]):
            out.append(f' service-port {sp["index"]} vlan {sp["vlan"]} gpon {sp["fsp"]} ont {sp["ont"]} gemport {sp["gem"]} multi-service user-vlan {sp["user_vlan"]} tag-transform translate')
        return "\n".join(out + ["#", "return"])


BANNER = "\r\n  Huawei Integrated Access Software (EMULADOR NexoISP - nao e equipamento real).\r\n\r\n"
LAB_USER = ("emu", "emu-lab")
# Só algoritmos antigos, como o firmware das OLTs mais velhas: obriga o cliente a usar o perfil legado.
LEGACY_ONLY = {"kex": ("diffie-hellman-group1-sha1", "diffie-hellman-group14-sha1"), "ciphers": ("aes128-cbc", "3des-cbc"),
               "digests": ("hmac-sha1", "hmac-md5"), "key_types": ("ssh-rsa",)}


def shell(state: "OltState", send, recv, banner: bool = True):  # pragma: no cover - exercitado pelos testes de transporte
    """Laço da CLI emulada sobre qualquer canal (send/recv de bytes ou str)."""
    cli = HuaweiCliEmulator(state)
    cli.mode = "user"
    send((BANNER if banner else "") + cli.prompt())
    buf = ""
    while True:
        data = recv(1024)
        if not data:
            return
        for chr_ in data.decode("utf-8", "ignore") if isinstance(data, bytes) else data:
            if chr_ in "\r\n":
                send("\r\n")
                out = cli.run(buf) if buf.strip() else ""
                buf = ""
                send((out.replace("\n", "\r\n") + "\r\n" if out else "") + "\r\n" + cli.prompt())
            elif chr_ != "\x00":
                buf += chr_
                send(chr_)


def ssh_client(conn, state: "OltState", key, legacy_only: bool = False):  # pragma: no cover
    import paramiko

    class Srv(paramiko.ServerInterface):
        def check_auth_password(self, u, p):
            return paramiko.AUTH_SUCCESSFUL if (u, p) == LAB_USER else paramiko.AUTH_FAILED

        def check_channel_request(self, kind, chanid):
            return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

        def check_channel_pty_request(self, *a):
            return True

        def check_channel_shell_request(self, channel):
            return True

    t = paramiko.Transport(conn)
    t.add_server_key(key)
    if legacy_only:
        opts = t.get_security_options()
        for name, values in LEGACY_ONLY.items():
            setattr(opts, name, values)
    try:
        t.start_server(server=Srv())
        ch = t.accept(20)
        if ch is not None:
            # sendall (não send): Channel.send pode enviar só parte de uma saída grande e o resto se perderia
            # (ex.: display current-configuration de uma OLT cheia), fazendo o cliente esperar um prompt que não vem.
            shell(state, lambda x: ch.sendall(x.encode() if isinstance(x, str) else x), ch.recv)
    except Exception:
        pass
    finally:
        t.close()


def _strip_iac(data: bytes) -> bytes:
    """Descarta a negociação de opções do telnet (IAC ...); o emulador não negocia nada."""
    out, i = bytearray(), 0
    while i < len(data):
        if data[i] == 255 and i + 1 < len(data):
            i += 3 if data[i + 1] in (251, 252, 253, 254) else 2
            continue
        out.append(data[i]); i += 1
    return bytes(out)


def telnet_client(conn, state: "OltState"):  # pragma: no cover
    """Login no formato das OLTs Huawei por telnet (">>User name:" / ">>User password:")."""
    def send(x):
        conn.sendall(x.encode() if isinstance(x, str) else x)

    def recv(n):
        return _strip_iac(conn.recv(n))

    def line(echo: bool) -> str:
        buf = ""
        while True:
            data = recv(1)
            if not data:
                raise EOFError
            c = data.decode("utf-8", "ignore")
            if c in "\r\n":
                if buf:
                    send("\r\n")
                    return buf
                continue
            if c != "\x00":
                buf += c
                if echo:
                    send(c)
    try:
        send(BANNER)
        for _ in range(3):
            send(">>User name:")
            user = line(True)
            send(">>User password:")
            password = line(False)
            if (user, password) == LAB_USER:
                shell(state, send, recv, banner=False)
                return
            send("\r\n  Username or password invalid.\r\n\r\n")
    except (OSError, EOFError):
        pass
    finally:
        conn.close()


def serve(port: int, state_path: str, mode: str = "ssh"):  # pragma: no cover - servidor de laboratório
    """Servidor de laboratório. mode: ssh (moderno), ssh-legacy (só algoritmos antigos) ou telnet. Usuário/senha: emu / emu-lab."""
    import socket
    import paramiko

    key = paramiko.RSAKey.generate(2048)
    state = OltState(state_path)
    if mode == "telnet":
        handler = lambda conn: telnet_client(conn, state)  # noqa: E731
    elif mode in ("ssh", "ssh-legacy"):
        handler = lambda conn: ssh_client(conn, state, key, legacy_only=mode == "ssh-legacy")  # noqa: E731
    else:
        raise SystemExit("modo deve ser ssh, ssh-legacy ou telnet")
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", port))
    sock.listen(20)
    print(f"emulador Huawei (NÃO é equipamento real) em :{port} ({mode})", flush=True)
    while True:
        conn, _ = sock.accept()
        threading.Thread(target=handler, args=(conn,), daemon=True).start()


if __name__ == "__main__":  # pragma: no cover
    import sys
    serve(int(sys.argv[1]), sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "ssh")
