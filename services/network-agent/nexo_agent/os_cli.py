"""Transporte CLI pelo cliente REAL do sistema (só biblioteca padrão): SSH pelo binário `ssh` via pty, e telnet em
Python puro. Serve às OLTs que o paramiko/netmiko não atende — firmwares SSH antigos e BusyBox/dropbear que dão
"Aiee, segfault!" com paramiko (ver docs/estudo-campo/recon-cli-olts.md). Mesma técnica do backup center: o `ssh` real
negocia o PTY e aceita algoritmos legados. Uso somente de leitura nos drivers que dependem dele.
"""
import os
import pty
import re
import select
import signal
import socket
import time

# Opções -o que religam algoritmos antigos que o OpenSSH novo só habilita sob demanda (sem ssh-dss, removido no OpenSSH 9/10).
LEGACY_SSH_OPTS = [
    "-o", "HostKeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedKeyTypes=+ssh-rsa",
    "-o", "KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1",
    "-o", "Ciphers=+aes128-cbc,3des-cbc,aes256-cbc",
]
_PAGE = re.compile(r"--\s*more\s*--|more:|press any key|more \(|press 'q'|---- more|continue\?", re.I)
# O equipamento avisou que ainda vai responder (ex.: Intelbras "processing, waiting to execute command"); não encerrar
# a leitura na ociosidade enquanto esse aviso for a última coisa recebida.
_KEEPWAIT = re.compile(r"processing|waiting to execute|starting configuration dump|please wait|aguarde", re.I)
_PWD = re.compile(r"(?i)(pass\s*word|senha)\s*:")
_LOGIN = re.compile(r"(?i)(login|user ?name|user)\s*:")


def _strip(text: str) -> str:
    """Tira cores/cursor ANSI e os apagamentos (\\b) que os paginadores usam ao redesenhar."""
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    out = []
    for ch in text:
        if ch == "\b":
            if out:
                out.pop()
        elif ch != "\r":
            out.append(ch)
    return "".join(out)


class _Pty:
    """Processo filho (ex.: `ssh`) atrás de um pty. Leitura/escrita pelo fd mestre."""

    def __init__(self, argv):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:  # filho
            try:
                os.execvp(argv[0], argv)
            except Exception:
                os._exit(127)
        self.buf = ""

    def read(self, timeout=0.4) -> str:
        try:
            r, _, _ = select.select([self.fd], [], [], timeout)
        except (OSError, ValueError):
            return ""
        if not r:
            return ""
        try:
            data = os.read(self.fd, 8192)
        except OSError:
            return ""
        return data.decode("latin1", "ignore")

    def write(self, text: str):
        os.write(self.fd, text.encode())

    def close(self):
        try:
            os.close(self.fd)
        except Exception:
            pass
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except Exception:
            pass


class _TelnetSock:
    """Telnet em Python puro: responde à negociação IAC (recusa tudo) e entrega o texto."""

    def __init__(self, host, port):
        self.s = socket.create_connection((host, port), timeout=20)
        self.s.settimeout(0.4)

    def read(self, timeout=0.4) -> str:
        self.s.settimeout(timeout)
        try:
            data = self.s.recv(8192)
        except socket.timeout:
            return ""
        except OSError:
            return ""
        clean, reply = _iac(data)
        if reply:
            try:
                self.s.sendall(reply)
            except Exception:
                pass
        return clean.decode("latin1", "ignore")

    def write(self, text: str):
        self.s.sendall(text.encode())

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


def _iac(data: bytes):
    out, rep, i = bytearray(), bytearray(), 0
    while i < len(data):
        b = data[i]
        if b == 255 and i + 1 < len(data):
            c = data[i + 1]
            if c == 255:
                out.append(255)
                i += 2
                continue
            if c in (251, 252, 253, 254) and i + 2 < len(data):
                opt = data[i + 2]
                rep += bytes((255, {253: 252, 251: 254, 252: 254, 254: 252}[c], opt))
                i += 3
                continue
            i += 2
            continue
        out.append(b)
        i += 1
    return bytes(out), bytes(rep)


class OsCliSession:
    """Sessão de CLI sobre um canal (_Pty do ssh, ou _TelnetSock). Login tolerante, leitura por ociosidade com
    tratamento de paginação, `run`/`dump` para os drivers. SÓ LEITURA."""

    def __init__(self, chan, prompt_re: str = r"[>#$%]\s*$"):
        self.chan = chan
        self.prompt_re = re.compile(prompt_re, re.M)

    def read_idle(self, idle=2.0, maxt=60, page=True) -> str:
        buf, last, start = "", time.time(), time.time()
        while time.time() - start < maxt:
            chunk = self.chan.read(0.4)
            if chunk:
                buf += chunk
                last = time.time()
                if page and _PAGE.search(_strip(buf[-160:])):
                    self.chan.write(" ")
            elif time.time() - last > idle:
                if _KEEPWAIT.search(buf[-200:]):  # o equipamento disse que ainda está processando: espera mais
                    last = time.time()
                    continue
                break
        return _strip(buf)

    def login(self, username: str, password: str, enable_password: str = "") -> str:
        """Login tolerante: responde a 'login:'/'password:' quando aparecem. SSH já autentica na linha de comando,
        mas pode pedir a senha; telnet pede login e senha."""
        out = ""
        for _ in range(6):
            chunk = self.read_idle(idle=1.2, maxt=10, page=False)
            out += chunk
            tail = chunk[-200:]
            if _PWD.search(tail):
                self.chan.write(password + "\n")
            elif _LOGIN.search(tail):
                self.chan.write(username + "\n")
            elif self.prompt_re.search(chunk.strip()[-60:] if chunk.strip() else ""):
                break
            elif not chunk:
                break
        if enable_password:
            self.chan.write("enable\n")
            e = self.read_idle(idle=1.2, maxt=8, page=False)
            out += e
            if _PWD.search(e[-200:]):
                self.chan.write(enable_password + "\n")
                out += self.read_idle(idle=1.2, maxt=8, page=False)
        return out

    def run(self, command: str, idle=2.0, maxt=90) -> str:
        self.chan.write(command + "\n")
        return self.read_idle(idle=idle, maxt=maxt)

    def dump(self, command: str, idle=3.0, maxt=300) -> str:
        self.chan.write(command + "\n")
        return self.read_idle(idle=idle, maxt=maxt)

    def close(self):
        try:
            self.chan.write("exit\n")
            time.sleep(0.2)
        except Exception:
            pass
        self.chan.close()


def _ssh_argv(host, port, username, *, legacy, known_hosts, strict):
    argv = ["ssh", "-p", str(port), "-o", "ConnectTimeout=25", "-o", "NumberOfPasswordPrompts=1",
            "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no"]
    if strict:
        if not known_hosts or not os.path.isabs(known_hosts):
            raise ValueError("SSH estrito exige known_hosts_file absoluto")
        argv += ["-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}"]
    else:
        argv += ["-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={known_hosts or '/dev/null'}"]
    if legacy:
        argv += LEGACY_SSH_OPTS
    argv += [f"{username}@{host}"]
    return argv


def connect(transport: str, host: str, port: int, username: str, password: str, cred: dict, prompt_re: str = r"[>#$%]\s*$") -> OsCliSession:
    """Abre a sessão pelo cliente do sistema. transport: 'ssh' (binário real, pty) ou 'telnet' (Python puro).
    cred: ssh_profile=legacy|modern, known_hosts_file, insecure_host_key (laboratório), enable_password."""
    if transport == "telnet":
        chan = _TelnetSock(host, port)
        sess = OsCliSession(chan, prompt_re)
        sess.login(username, password, cred.get("enable_password", ""))
        return sess
    if transport == "ssh":
        legacy = (cred.get("ssh_profile") or "modern") == "legacy"
        strict = not bool(cred.get("insecure_host_key"))
        argv = _ssh_argv(host, port, username, legacy=legacy, known_hosts=cred.get("known_hosts_file", ""), strict=strict)
        chan = _Pty(argv)
        sess = OsCliSession(chan, prompt_re)
        sess.login(username, password, cred.get("enable_password", ""))
        return sess
    raise ValueError(f"transporte OS desconhecido: {transport!r}")
