"""Cliente SOMENTE LEITURA da API do IXCSoft, para migrar os dados do PRÓPRIO provedor para o NexoISP.

Garantias (iguais às do cliente SGP):
- só listagem (`oper`/método de LEITURA) e só nas tabelas da lista abaixo; qualquer outra coisa é recusada aqui;
- token vem do ambiente (IXC_URL, IXC_TOKEN), nunca de arquivo do repositório;
- só HTTPS (exceto localhost); sem redirecionamento para outro host; nenhum valor de resposta vai para log.
API IXC: POST {url}/webservice/v1/{tabela} com Basic auth base64(token) e header 'ixcsoft: listar';
corpo JSON de grade (qtype/query/oper/page/rp/sortname/sortorder). Resposta: {"total","registros":[...]}.
"""
from __future__ import annotations
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

# Tabelas de CONSULTA que interessam à migração (cadastro, contrato, login PPPoE, financeiro, planos, concentradores).
ALLOWED = {
    "cliente", "cliente_contrato", "radusuarios", "fn_areceber",
    "radpop", "radgrupos", "vd_contratos", "radservicos",
}
SENSITIVE_KEY_HINTS = ("senha", "password", "passwd", "secret", "token", "chave", "pwd", "hash")


class IxcError(Exception):
    pass


class _SameHostOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlparse(newurl).netloc != urllib.parse.urlparse(req.full_url).netloc:
            raise IxcError("o servidor redirecionou para outro endereço; recusado")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class IxcClient:
    def __init__(self, base_url: str | None = None, token: str | None = None, pause_s: float = 0.3, timeout_s: float = 45.0):
        self.base = (base_url or os.environ.get("IXC_URL", "")).rstrip("/")
        self.token = token or os.environ.get("IXC_TOKEN", "")
        if not (self.base and self.token):
            raise IxcError("defina IXC_URL e IXC_TOKEN no ambiente")
        u = urllib.parse.urlparse(self.base)
        if u.scheme != "https" and u.hostname not in ("localhost", "127.0.0.1"):
            raise IxcError("somente HTTPS (http só para localhost)")
        self.pause_s, self.timeout_s = pause_s, timeout_s
        self._auth = base64.b64encode(self.token.encode()).decode()
        self._opener = urllib.request.build_opener(_SameHostOnly)

    def listar(self, tabela: str, page: int = 1, rp: int = 100, query: str = "", qtype: str = "", sortname: str = "id", sortorder: str = "asc") -> dict:
        if tabela not in ALLOWED:
            raise IxcError(f"tabela fora da lista de consulta: {tabela}")
        body = json.dumps({"qtype": qtype or f"{tabela}.id", "query": query, "oper": "" if query == "" else ">", "page": str(page),
                            "rp": str(rp), "sortname": sortname or f"{tabela}.id", "sortorder": sortorder}).encode()
        req = urllib.request.Request(f"{self.base}/webservice/v1/{tabela}", data=body, method="GET",
                                     headers={"Content-Type": "application/json", "Authorization": "Basic " + self._auth, "ixcsoft": "listar"})
        last: Exception | None = None
        for attempt in range(3):
            try:
                with self._opener.open(req, timeout=self.timeout_s) as r:
                    time.sleep(self.pause_s)
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 404):
                    raise IxcError(f"{tabela}: HTTP {e.code} (credencial sem permissão ou tabela inexistente)") from None
                last = e
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                last = e
            time.sleep(1.5 * (attempt + 1))
        raise IxcError(f"{tabela}: falhou após 3 tentativas ({type(last).__name__})")

    def pages(self, tabela: str, rp: int = 100, max_pages: int = 10_000, **kw):
        for n in range(1, max_pages + 1):
            data = self.listar(tabela, page=n, rp=rp, **kw)
            regs = data.get("registros") if isinstance(data, dict) else None
            if not isinstance(regs, list):
                raise IxcError(f"{tabela}: resposta sem 'registros' (verifique a credencial/tabela)")
            yield from regs
            if len(regs) < rp:
                return
        raise IxcError(f"{tabela}: paginação não terminou em {max_pages} páginas")
