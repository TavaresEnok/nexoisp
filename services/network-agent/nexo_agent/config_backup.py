"""Backup semanal da configuração dos equipamentos que o NexoISP gerencia (OLTs e concentradores).

Quem decide QUANDO é a nuvem: ela devolve, junto das observações, a data em que cada equipamento vence o backup
(7 dias depois do último, ou agora quando alguém pede pelo painel). O agente só executa, um equipamento por vez, numa
thread própria e com sessão própria no equipamento, para nunca atrasar as operações de rede. Sem verificações extras:
nada roda entre um backup e outro.

    agendado: no máximo um backup a cada SCHEDULED_GAP_S (espalha a carga quando vários vencem juntos)
    pedido pelo painel: começa no ciclo seguinte
    falha: nova tentativa só depois de RETRY_AFTER_S, salvo novo pedido feito depois da falha
"""
import logging
import re
import threading
import time
from datetime import datetime

log = logging.getLogger(__name__)

SCHEDULED_GAP_S = 300
RETRY_AFTER_S = 6 * 3600
MAX_BYTES = 15 * 1024 * 1024

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_ERASE = re.compile(r"\x1b\[\d+D[ ]*\x1b\[\d+D")  # o equipamento apaga a marca de paginação: volta o cursor, espaços, volta de novo
_PAGER = re.compile(r"[ \t]*-+\s*More\s*(\(.*?\))?\s*-+")
_CONFIRM = re.compile(r"^\s*\{\s*<cr>.*\}\s*:\s*$")


def clean_cli_output(text: str) -> str:
    """Remove o que é da sessão e não da configuração: cores/cursor, marcas de paginação e a pergunta "{ <cr>|... }:"."""
    out = []
    for line in _ANSI.sub("", _ERASE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))).split("\n"):
        paged = _PAGER.sub("", line)
        if _CONFIRM.match(paged) or (paged != line and not paged.strip()):
            continue
        line = paged
        out.append(line.rstrip())
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


def _epoch(value) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class ConfigBackups:
    def __init__(self, client, drivers, threaded: bool = True):
        self.client, self.drivers, self.threaded = client, drivers, threaded
        self.schedule: dict[str, dict] = {}
        self.failed: dict[str, float] = {}
        self.last_scheduled = 0.0
        self.running: threading.Thread | None = None

    def update(self, items) -> None:
        """Agenda vinda da nuvem: [{device_id, due_at, manual}]. Equipamento fora da lista não tem backup (desligado ou sem suporte)."""
        if items is None:
            return  # nuvem antiga: não mexe na agenda
        self.schedule = {i["device_id"]: {"due": _epoch(i.get("due_at")), "manual": bool(i.get("manual"))} for i in items if i.get("device_id")}

    def next_due(self, now: float) -> tuple[str, bool] | None:
        candidates = []
        for dev_id, item in self.schedule.items():
            drv = self.drivers().get(dev_id)
            if item["due"] is None or item["due"] > now or drv is None or not hasattr(drv, "export_config"):
                continue
            failed = self.failed.get(dev_id)
            if failed and now - failed < RETRY_AFTER_S and not (item["manual"] and item["due"] > failed):
                continue
            if not item["manual"] and now - self.last_scheduled < SCHEDULED_GAP_S:
                continue
            candidates.append((not item["manual"], item["due"], dev_id))
        if not candidates:
            return None
        _, _, dev_id = min(candidates)  # pedidos do painel primeiro; depois o mais atrasado
        return dev_id, self.schedule[dev_id]["manual"]

    def tick(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        if self.running is not None and self.running.is_alive():
            return
        job = self.next_due(now)
        if job is None:
            return
        dev_id, manual = job
        if not manual:
            self.last_scheduled = now
        self.schedule[dev_id]["due"] = None  # não repete até a nuvem devolver a próxima data
        if self.threaded:
            self.running = threading.Thread(target=self.run, args=(dev_id, now), name=f"config-backup-{dev_id[:8]}", daemon=True)
            self.running.start()
        else:
            self.run(dev_id, now)

    def run(self, dev_id: str, started: float) -> None:
        drv = self.drivers().get(dev_id)
        try:
            text = drv.export_config()
            if len(text.encode()) > MAX_BYTES:
                raise RuntimeError(f"configuração maior que {MAX_BYTES // (1024 * 1024)} MB; backup não registrado")
            if not text.strip():
                raise RuntimeError("equipamento devolveu configuração vazia")
            body = {"device_id": dev_id, "ok": True, "content": text, "seconds": round(max(0.0, time.time() - started), 1)}
            self.failed.pop(dev_id, None)
        except Exception as e:
            self.failed[dev_id] = started
            log.warning("backup de configuração do equipamento %s falhou: %s", dev_id, e)
            body = {"device_id": dev_id, "ok": False, "error": str(e)[:500] or e.__class__.__name__, "seconds": round(max(0.0, time.time() - started), 1)}
        try:
            r = self.client.config_backup(body)
            if r and r.get("next_due_at") is not None and dev_id in self.schedule:
                self.schedule[dev_id]["due"] = _epoch(r["next_due_at"])
            if body["ok"]:
                log.info("backup de configuração do equipamento %s registrado (%d bytes)", dev_id, len(body["content"].encode()))
        except Exception as e:
            self.failed[dev_id] = started
            log.warning("envio do backup de configuração do equipamento %s falhou: %s", dev_id, e)
