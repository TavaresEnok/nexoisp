"""Console telnet de um nó do PNETLab (RouterOS). Uso: ros_console.py <porta> '<comando>' [...]
Entra como admin sem senha e NÃO define senha quando o RouterOS oferece trocar (Ctrl-C)."""
import re
import socket
import sys
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\x1b[=>]|\r|\x00")
PROMPT = r"\] >\s*$"


class Con:
    def __init__(self, port: int):
        self.s = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.s.settimeout(1)

    def read(self, t=3.0, until=None) -> str:
        end, out = time.time() + t, ""
        while time.time() < end:
            try:
                d = self.s.recv(65535)
            except socket.timeout:
                if out.strip() and not until:
                    break
                continue
            if not d:
                break
            out += ANSI.sub("", re.sub(rb"\xff[\xfb-\xfe].", b"", d).decode(errors="replace"))
            if until and re.search(until, out):
                break
        return out

    def send(self, line: str):
        self.s.sendall(line.encode() + b"\r")

    def login(self, wait=90) -> bool:
        t0 = time.time()
        while time.time() - t0 < wait:
            self.send("")
            o = self.read(4)
            if re.search(PROMPT, o):
                return True
            if "Login:" in o:
                self.send("admin+ct511w200h")  # sem cores, terminal largo
                self.read(5, until=r"Password:")
                self.send("")
                o = self.read(15, until=PROMPT + r"|\[Y/n\]|new password>")
                if "[Y/n]" in o:
                    self.send("n")
                    o = self.read(10, until=PROMPT + r"|new password>")
                if "new password>" in o:
                    self.s.sendall(b"\x03")
                    o = self.read(5, until=PROMPT)
                if re.search(PROMPT, o):
                    return True
            time.sleep(2)
        return False

    def cmd(self, c: str, t=30) -> str:
        self.send(c)
        o = self.read(t, until=PROMPT).replace(c, "", 1)
        return re.sub(r"\[9999B|\[admin@[^\]]*\] >\s*$", "", o).strip()


if __name__ == "__main__":
    con = Con(int(sys.argv[1]))
    if not con.login():
        raise SystemExit("console não respondeu")
    for q in sys.argv[2:]:
        print(con.cmd(q))
