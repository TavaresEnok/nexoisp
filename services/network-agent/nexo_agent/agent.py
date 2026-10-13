"""Laço principal: conectar, sincronizar por completo, recuperar interrompidas e só então aceitar novas escritas."""
import json
import logging
import os
import signal
import time
import uuid
from datetime import datetime, timedelta, timezone

from . import __version__
from .client import CloudClient
from .drivers.demo import DemoDriver
from .executor import Executor, observation, onu_observation
from .store import Store

log = logging.getLogger("nexo.agent")


class Agent:
    def __init__(self, client, store: Store, data_dir: str, credentials: dict | None = None, poll_s: float = 2.0, observe_s: float = 15.0):
        self.client, self.store, self.data_dir = client, store, data_dir
        self.credentials = credentials or {}
        self.poll_s, self.observe_s = poll_s, observe_s
        self.session_id = uuid.uuid4().hex  # identifica este processo; sincronização vale só para ele
        self.ident: dict = {}
        self.drivers: dict = {}
        self.devices: dict = {}
        self.synced = False
        self.stop = False
        self.executor = Executor(store, client, lambda d: self.drivers.get(d), lambda: self.ident)
        self._last_observe = 0.0
        self._last_full = 0.0
        self._last_maint = time.time()
        self._obs_cache: dict = {}
        self._olt_last: dict = {}
        self._usage_last = 0.0

    def _build_driver(self, dev: dict):
        if dev["driver"] == "demo":
            return DemoDriver(os.path.join(self.data_dir, "demo_nas.sqlite"), dev["id"])
        if dev["driver"] == "olt_demo":
            from .drivers.olt_demo import DemoOltDriver
            return DemoOltDriver(os.path.join(self.data_dir, "demo_olt.sqlite"), dev["id"])
        if dev["driver"] == "olt_huawei":
            from .drivers.olt_huawei import HuaweiOltDriver
            return HuaweiOltDriver.from_device(dev, self.credentials)
        if dev["driver"] == "mikrotik_radius":
            from .drivers.mikrotik_radius import MikrotikRadiusDriver
            return MikrotikRadiusDriver.from_device(dev, self.credentials, self.data_dir)
        raise ValueError(f"driver desconhecido: {dev['driver']}")

    def _checks(self) -> list:
        out = []
        for dev_id, drv in self.drivers.items():
            try:
                r = drv.check()
            except Exception as e:
                r = {"ok": False, "detail": str(e)[:300]}
            out.append({"device_id": dev_id, "ok": bool(r.get("ok")), "detail": str(r.get("detail", ""))[:500], "at": datetime.now(timezone.utc).isoformat()})
        return out

    def _observe_all(self, full: bool = True) -> list:
        """Lê o estado das contas conhecidas. Em lote por equipamento quando o driver suporta; envia só o que mudou
        (e tudo a cada sincronização/5 min, para manter a data da observação atual na nuvem)."""
        by_dev: dict[str, list] = {}
        for r in self.store.resources():
            by_dev.setdefault(r["device_id"], []).append(r)
        items = []
        for dev_id, rows in by_dev.items():
            drv = self.drivers.get(dev_id)
            if not drv:
                continue
            try:
                states = drv.read_many([r["username"] for r in rows]) if hasattr(drv, "read_many") else None
            except Exception as e:
                log.warning("leitura em lote do equipamento %s falhou: %s", dev_id, e)
                continue
            for r in rows:
                try:
                    o = observation(states[r["username"]] if states is not None else drv.read(r["username"]))
                except Exception as e:
                    log.warning("leitura de %s falhou: %s", r["username"], e)
                    continue
                sig = json.dumps([o["policy"], o["profile"], (o["session"] or {}).get("online"), (o["session"] or {}).get("ip")])
                if full or self._obs_cache.get(r["resource_id"]) != sig:
                    self._obs_cache[r["resource_id"]] = sig
                    items.append({"resource_id": r["resource_id"], **o})
        return items

    def _olt_reports(self):
        """Por OLT: ONUs aguardando autorização (lista completa) e estado/sinal das ONUs conhecidas."""
        known: dict[str, list] = {}
        for o in self.store.onus():
            known.setdefault(o["device_id"], []).append(o)
        for dev_id, drv in self.drivers.items():
            if not hasattr(drv, "discover"):
                continue
            if time.time() - self._olt_last.get(dev_id, 0) < getattr(drv, "poll_interval_s", 0):
                continue  # equipamento real: ciclo mais espaçado que o do simulador
            self._olt_last[dev_id] = time.time()
            try:
                unauthorized = drv.discover()
            except Exception as e:  # sem leitura completa não se relata lista vazia (não gera exclusões na nuvem)
                log.warning("descoberta de ONUs na OLT %s falhou: %s", dev_id, e)
                continue
            states, rows = [], known.get(dev_id, [])
            try:
                bulk = drv.read_onus([o["serial"] for o in rows]) if rows and hasattr(drv, "read_onus") else None
            except Exception as e:
                log.warning("leitura em lote das ONUs da OLT %s falhou: %s", dev_id, e)
                bulk = {}
            for o in rows:
                try:
                    st = bulk.get(o["serial"]) if bulk is not None else drv.read_onu(o["serial"])
                    if st is not None:
                        states.append({"onu_id": o["onu_id"], **onu_observation(st)})
                except Exception as e:
                    log.warning("leitura da ONU %s falhou: %s", o["serial"], e)
            self.client.olt_report(dev_id, unauthorized, states, complete=True)

    def _usage_reports(self):
        """Consumo do mês corrente e do anterior, do accounting local. Espaçado (15 min); falha aqui nunca atrapalha as operações."""
        now = time.time()
        if now - self._usage_last < 900:
            return
        self._usage_last = now
        t = datetime.now(timezone.utc)
        first = t.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        prev = (first - timedelta(days=1)).replace(day=1)
        by_dev: dict[str, dict] = {}
        for r in self.store.resources():
            by_dev.setdefault(r["device_id"], {})[r["username"]] = r["resource_id"]
        for dev_id, accounts in by_dev.items():
            drv = self.drivers.get(dev_id)
            if drv is None or not hasattr(drv, "usage"):
                continue
            try:
                found = drv.usage(list(accounts), prev.timestamp())
                items = [{"resource_id": accounts[u], "month": m, **v} for u, months in found.items() for m, v in months.items()]
                if items:
                    self.client.usage_report(dev_id, items)
            except Exception as e:
                log.warning("relato de consumo do equipamento %s falhou: %s", dev_id, e)

    def connect_and_sync(self):
        h = self.client.hello(self.session_id, __version__, {"drivers": sorted({d for d in ("demo", "mikrotik_radius")})})
        pinned = self.store.get_kv("signing_public_key")
        if pinned and pinned != h["signing_public_key"]:
            raise RuntimeError("chave de assinatura da nuvem mudou; reconfigure o agente explicitamente (remova o pin) após validar a troca")
        if not pinned:
            self.store.set_kv("signing_public_key", h["signing_public_key"])
        self.devices = {d["id"]: d for d in h["devices"]}
        self.drivers = {}
        for d in h["devices"]:
            try:
                self.drivers[d["id"]] = self._build_driver(d)
            except Exception as e:
                log.error("driver de %s indisponível: %s", d["name"], e)
        self.ident = {"agent_id": h["agent_id"], "tenant_id": h["tenant_id"], "public_key": h["signing_public_key"], "device_ids": set(self.devices)}
        snap = h["snapshot"]
        if snap.get("complete"):  # snapshot parcial nunca gera exclusões nem substitui o mapa local
            for r in snap["resources"]:
                self.store.upsert_resource(r["resource_id"], r["device_id"], r["username"])
            for o in snap.get("onus", []):
                self.store.upsert_onu(o["onu_id"], o["device_id"], o["serial"])
        self.executor.recover_interrupted()   # consulta antes de qualquer nova escrita
        self.executor.flush_outbox()
        self.client.sync_done(self.session_id, self._observe_all(), self._checks())
        self._olt_reports()
        self.synced = True
        self._last_observe = self._last_full = time.time()
        log.info("sincronizado: %d equipamento(s), %d conta(s)", len(self.devices), len(self.store.resources()))

    def tick(self):
        if not self.synced:
            self.connect_and_sync()
        self.executor.flush_outbox()
        r = self.client.poll(self.session_id)
        if r.get("need_sync"):
            self.synced = False
            return False
        handled = bool(r.get("operation"))
        if handled:
            self.executor.handle(r["operation"])
        if time.time() - self._last_observe >= self.observe_s:
            full = time.time() - self._last_full >= 300
            self.client.observations(self._observe_all(full), self._checks())
            self._olt_reports()
            self._usage_reports()
            self._last_observe = time.time()
            if full:
                self._last_full = self._last_observe
        if time.time() - self._last_maint >= 6 * 3600:  # manutenção local periódica (limpeza do accounting, tentativas antigas)
            self._last_maint = time.time()
            self.store.prune()
            for drv in self.drivers.values():
                if hasattr(drv, "maintenance"):
                    try:
                        log.info("manutenção local: %s", drv.maintenance())
                    except Exception as e:
                        log.warning("manutenção local falhou: %s", e)
        return handled

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stop", True))
        backoff = 1.0
        while not self.stop:
            try:
                busy = self.tick()
                backoff = 1.0
                if not busy:  # com fila, puxa a próxima imediatamente (execução continua serial por agente)
                    time.sleep(self.poll_s)
            except Exception as e:
                # Nuvem indisponível: nenhuma escrita nova; o RADIUS local segue com a última política conhecida.
                log.warning("sem comunicação com a nuvem (%s); nova tentativa em %.0fs", e, backoff)
                self.synced = False
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)


def main():
    logging.basicConfig(level=os.environ.get("NEXO_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("paramiko").setLevel(logging.WARNING)
    logging.getLogger("netmiko").setLevel(logging.WARNING)
    data_dir = os.environ.get("NEXO_AGENT_DATA", "./data")
    os.makedirs(data_dir, mode=0o700, exist_ok=True)
    creds_path = os.environ.get("NEXO_AGENT_CREDENTIALS")
    credentials = json.load(open(creds_path)) if creds_path and os.path.exists(creds_path) else {}
    client = CloudClient(os.environ["NEXO_API_URL"], os.environ["NEXO_AGENT_TOKEN"], os.environ.get("NEXO_AGENT_TLS_DIR"))
    Agent(client, Store(os.path.join(data_dir, "agent.sqlite")), data_dir, credentials).run()


if __name__ == "__main__":
    main()
