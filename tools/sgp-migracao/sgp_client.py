"""Cliente SOMENTE LEITURA da API do SGP, para migrar os dados do PRÓPRIO provedor para o NexoISP.

Garantias:
- só chama rotas da lista abaixo (consultas); qualquer outra é recusada antes de sair da máquina;
- o token vem do ambiente (SGP_TOKEN, SGP_APP, SGP_URL), nunca de arquivo do repositório nem de argumento de linha de comando;
- só HTTPS (exceto localhost, para testes) e sem seguir redirecionamento para outro servidor;
- nenhum valor de resposta é registrado em log.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

# Rotas de consulta da documentação do SGP (docs/API-SGP-completa.txt). Escrita/alteração não está aqui de propósito.
ALLOWED = {
    "/api/ura/clientes/",            # Cliente - Listar
    "/api/ura/listacliente/",        # Cliente - Listagem resumida
    "/api/ura/consultacliente/",     # Cliente - Consultar
    "/api/ura/listacontrato/",       # Contrato - Listar
    "/api/ura/titulos/",             # Fatura - Listar
    "/api/ura/ordemservico/list/",   # Ordem de serviço - Listar
    "/api/ura/ocorrencia/list/",     # Ocorrência - Listar
    "/api/ura/consultaplano/",       # Plano - Listar
    "/api/ura/pops/",                # POP - Listar
    "/api/ura/nas/list/",            # NAS - Listar
    "/api/ura/portador/",            # Portador - Listar
}
SENSITIVE_KEY_HINTS = ("senha", "password", "passwd", "secret", "token", "chave", "pwd")


class SgpError(Exception):
    pass


class _SameHostOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            raise SgpError("o servidor redirecionou para outro endereço; recusado")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class SgpClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, app: str | None = None, pause_s: float = 0.25, timeout_s: float = 30.0):
        self.base = (base_url or os.environ.get("SGP_URL", "")).rstrip("/")
        self.token = token or os.environ.get("SGP_TOKEN", "")
        self.app = app or os.environ.get("SGP_APP", "")
        if not (self.base and self.token and self.app):
            raise SgpError("defina SGP_URL, SGP_TOKEN e SGP_APP no ambiente")
        u = urllib.parse.urlparse(self.base)
        if u.scheme != "https" and u.hostname not in ("localhost", "127.0.0.1"):
            raise SgpError("somente HTTPS (http só para localhost)")
        self.pause_s, self.timeout_s = pause_s, timeout_s
        self._opener = urllib.request.build_opener(_SameHostOnly)

    def post(self, path: str, params: dict | None = None) -> object:
        if path not in ALLOWED:
            raise SgpError(f"rota fora da lista de consulta: {path}")
        body = urllib.parse.urlencode({**(params or {}), "token": self.token, "app": self.app}).encode()
        req = urllib.request.Request(self.base + path, data=body, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
        last: Exception | None = None
        for attempt in range(3):
            try:
                with self._opener.open(req, timeout=self.timeout_s) as r:
                    time.sleep(self.pause_s)   # gentileza com o servidor de produção do provedor
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404):
                    raise SgpError(f"{path}: HTTP {e.code} (credencial sem permissão ou rota inexistente nesta versão)") from None
                last = e
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                last = e
            time.sleep(1.5 * (attempt + 1))
        raise SgpError(f"{path}: falhou após 3 tentativas ({type(last).__name__})")

    def pages(self, path: str, params: dict | None = None, list_path: str = "", size: int = 100, offset_param: str = "offset", limit_param: str = "limit",
              max_pages: int = 10_000):
        """Percorre a paginação por offset/limit até vir uma página menor que `size`."""
        for n in range(max_pages):
            data = self.post(path, {**(params or {}), offset_param: n * size, limit_param: size})
            rows = dig(data, list_path) if list_path else data
            if not isinstance(rows, list):
                raise SgpError(f"{path}: a resposta não tem uma lista em '{list_path or '(raiz)'}'; rode o amostrador e ajuste o mapeamento")
            yield from rows
            if len(rows) < size:
                return
        raise SgpError(f"{path}: paginação não terminou em {max_pages} páginas")


def dig(obj, path: str):
    """Caminho com pontos e índices: 'contratos.0.servicos.0.login'. Ausente devolve None."""
    cur = obj
    for part in [p for p in path.split(".") if p != ""]:
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur
