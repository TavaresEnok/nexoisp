"""Servidor de LABORATÓRIO para os emuladores de OLT (ZTE, Datacom, VSOL, FiberHome): telnet de verdade.

Cada emulador é uma `LabCli` (estado + execução de comandos). Este módulo cuida do que é comum: login no estilo do
equipamento, `enable` com senha, eco do que é digitado (sem eco na senha), CR/LF, negociação telnet ignorada e o gancho
`on_command`, que grava cada comando executado — é o que permite ao laboratório provar que os comandos reais chegaram ao
equipamento (emulado) pelo transporte de verdade.

NADA aqui é software dos fabricantes. Passar no laboratório prova lógica e transporte, NÃO homologação de firmware real.
"""
import socket
import threading

ENABLE_PASSWORD_PROMPT = object()  # sentinela: execute() pede a senha do enable


class LabCli:
    """Base dos emuladores. Subclasses implementam prompt() e execute(cmd) -> texto (ou ENABLE_PASSWORD_PROMPT)."""

    username = "emu"
    password = "emu-lab"
    enable_password = None          # None: enable sem senha
    user_prompt = "Username:"
    pass_prompt = "Password:"
    banner = "\r\n  EMULADOR de laboratório NexoISP — NÃO é equipamento real.\r\n\r\n"

    def __init__(self):
        self.stage = "user"
        self._user = ""

    # --- ciclo de login/enable ------------------------------------------------------------------------------------
    @property
    def hidden(self) -> bool:
        return self.stage in ("pass", "enable_pass")

    def greeting(self) -> str:
        return self.banner + self.user_prompt

    def on_login(self):
        """Gancho: modo inicial após o login (ex.: '>' de usuário)."""

    def on_enable(self):
        """Gancho: entra no modo privilegiado."""

    def feed(self, line: str) -> str:
        if self.stage == "user":
            self._user = line.strip()
            self.stage = "pass"
            return self.pass_prompt
        if self.stage == "pass":
            if (self._user, line) == (self.username, self.password):
                self.stage = "cli"
                self.on_login()
                return "\r\n" + self.prompt()
            self.stage = "user"
            return "\r\n% Username or password invalid.\r\n\r\n" + self.user_prompt
        if self.stage == "enable_pass":
            self.stage = "cli"
            if line == self.enable_password:
                self.on_enable()
                return "\r\n" + self.prompt()
            return "\r\n% Access denied\r\n" + self.prompt()
        cmd = line.strip()
        if not cmd:
            return self.prompt()
        out = self.execute(cmd)
        if out is ENABLE_PASSWORD_PROMPT:
            self.stage = "enable_pass"
            return self.pass_prompt
        return (out.replace("\r\n", "\n").replace("\n", "\r\n") + "\r\n" if out else "") + self.prompt()

    # --- a implementar ----------------------------------------------------------------------------------------------
    def prompt(self) -> str:  # pragma: no cover - abstrato
        raise NotImplementedError

    def execute(self, cmd: str):  # pragma: no cover - abstrato
        raise NotImplementedError

    def label(self, cmd: str) -> str:
        """Como o comando é gravado na prova. Subclasses marcam o logout de sessão ('exit' fora da configuração) como
        '<logout>' para não confundir com o 'exit' de um modo de configuração."""
        return cmd

    def enable(self):
        """Comportamento padrão do 'enable': pede senha se houver, senão entra direto."""
        if self.enable_password:
            return ENABLE_PASSWORD_PROMPT
        self.on_enable()
        return ""


def _strip_iac(data: bytes) -> bytes:
    out, i = bytearray(), 0
    while i < len(data):
        if data[i] == 255 and i + 1 < len(data):
            i += 3 if data[i + 1] in (251, 252, 253, 254) else 2
            continue
        out.append(data[i])
        i += 1
    return bytes(out)


def telnet_session(conn, cli: LabCli, on_command=None):
    """Atende uma conexão telnet até o cliente fechar."""
    def send(text):
        try:
            conn.sendall(text.encode("utf-8"))
        except OSError:
            pass

    buf, last = "", ""
    send(cli.greeting())
    try:
        while True:
            data = conn.recv(1024)
            if not data:
                return
            for ch in _strip_iac(data).decode("utf-8", "ignore"):
                if ch == "\n" and last == "\r":  # CRLF conta como um só Enter
                    last = ch
                    continue
                last = ch
                if ch in "\r\n":
                    send("\r\n")
                    line, buf = buf, ""
                    in_cli = cli.stage == "cli"
                    label = cli.label(line.strip()) if in_cli and line.strip() else None
                    out = cli.feed(line)
                    if label and on_command:
                        on_command(label)
                    send(out)
                elif ch in ("\x08", "\x7f"):
                    buf = buf[:-1]
                elif ch != "\x00":
                    buf += ch
                    if not cli.hidden:
                        send(ch)
    except OSError:
        return
    finally:
        try:
            conn.close()
        except OSError:
            pass


def serve_telnet(cli_factory, on_command=None, host: str = "127.0.0.1", port: int = 0):
    """Sobe o servidor de laboratório numa thread. Cada conexão ganha uma CLI nova sobre o MESMO estado (o factory
    fecha sobre o estado). Devolve (socket, porta)."""
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(8)

    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=telnet_session, args=(conn, cli_factory(), on_command), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()
    return sock, sock.getsockname()[1]


def main(argv=None):  # pragma: no cover - servidor manual de laboratório
    """python -m nexo_agent.drivers.lab_cli_server <zte|zte-c300|datacom|vsol|fiberhome> <porta>"""
    import sys
    import time
    argv = argv or sys.argv[1:]
    if len(argv) != 2:
        raise SystemExit(main.__doc__)
    vendor, port = argv[0], int(argv[1])
    factory = lab_factory(vendor)
    serve_telnet(factory, host="0.0.0.0", port=port)
    print(f"emulador {vendor} (NÃO é equipamento real) em :{port} (telnet, {LabCli.username}/{LabCli.password})", flush=True)
    while True:
        time.sleep(3600)


def lab_factory(vendor: str):
    """Fábrica de CLI por fabricante, com estado compartilhado entre as conexões."""
    if vendor in ("zte", "zte-c300"):
        from .olt_zte_emulator import ZteState, ZteCli
        state = ZteState(style="c300" if vendor == "zte-c300" else "xgspon")
        return lambda: ZteCli(state)
    if vendor == "datacom":
        from .olt_datacom_emulator import DatacomState, DatacomCli
        state = DatacomState()
        return lambda: DatacomCli(state)
    if vendor == "vsol":
        from .olt_vsol_emulator import VsolState, VsolCli
        state = VsolState()
        return lambda: VsolCli(state)
    if vendor == "fiberhome":
        from .olt_fiberhome_emulator import FiberHomeState, FiberHomeCli
        state = FiberHomeState()
        return lambda: FiberHomeCli(state)
    raise SystemExit(f"fabricante desconhecido: {vendor}")


if __name__ == "__main__":  # pragma: no cover
    main()
