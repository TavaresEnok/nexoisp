"""Cliente HTTP do agente. A conexão é sempre iniciada pelo agente (saída), com mTLS e token individuais."""
import ssl

import httpx


class CloudClient:
    def __init__(self, base_url: str, token: str, tls_dir: str | None):
        kw = {}
        if tls_dir:
            # Verificação do servidor SEMPRE ativa; certificado de cliente identifica este agente.
            ctx = ssl.create_default_context(cafile=f"{tls_dir}/ca.crt")
            ctx.load_cert_chain(f"{tls_dir}/agent.crt", f"{tls_dir}/agent.key")
            kw = {"verify": ctx}
        elif base_url.startswith("https://"):
            raise RuntimeError("NEXO_AGENT_TLS_DIR é obrigatório para conexões https")
        self._http = httpx.Client(base_url=base_url, headers={"Authorization": f"Bearer {token}"}, timeout=15.0, **kw)

    def _post(self, path: str, body: dict) -> dict:
        r = self._http.post(path, json=body)
        r.raise_for_status()
        return r.json()

    def hello(self, session_id: str, version: str, info: dict) -> dict:
        return self._post("/agent/v1/hello", {"session_id": session_id, "version": version, "info": info})

    def sync_done(self, session_id: str, observations: list, device_checks: list) -> dict:
        return self._post("/agent/v1/sync-done", {"session_id": session_id, "observations": observations, "device_checks": device_checks})

    def poll(self, session_id: str) -> dict:
        return self._post("/agent/v1/poll", {"session_id": session_id})

    def begin(self, attempt_id: str) -> dict:
        return self._post(f"/agent/v1/attempts/{attempt_id}/begin", {})

    def progress(self, attempt_id: str, status: str, steps: list) -> dict:
        return self._post(f"/agent/v1/attempts/{attempt_id}/progress", {"status": status, "steps": steps})

    def result(self, attempt_id: str, outcome: dict) -> dict:
        return self._post(f"/agent/v1/attempts/{attempt_id}/result", outcome)

    def observations(self, items: list, device_checks: list) -> dict:
        return self._post("/agent/v1/observations", {"items": items, "device_checks": device_checks})

    def olt_report(self, device_id: str, unauthorized: list, states: list, complete: bool = True) -> dict:
        return self._post("/agent/v1/olt-report", {"device_id": device_id, "complete": complete, "unauthorized": unauthorized, "states": states})

    def usage_report(self, device_id: str, items: list) -> dict:
        return self._post("/agent/v1/usage-report", {"device_id": device_id, "items": items})
