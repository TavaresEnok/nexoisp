"""Contrato dos drivers de OLT (expansão OLT/ONU). Um fabricante/modelo/firmware por driver; nada de CLI livre."""
import re
from dataclasses import dataclass, field
from typing import Optional, Protocol

_MARK = re.compile(r"^nexo:[0-9a-f]{8}:v(\d+)$")


def version_from_description(description: Optional[str]) -> Optional[int]:
    """A descrição gravada na ONU carrega a versão da intenção: permite saber, lendo a OLT, qual operação produziu o estado."""
    m = _MARK.match(description or "")
    return int(m.group(1)) if m else None


# --- Escrita (autorizar/desautorizar): utilitários comuns aos drivers que provisionam ---------------------------------
_SAFE = re.compile(r"^[A-Za-z0-9_.:\-]{1,64}$")
_ID_PRODUCT = re.compile(r"(?im)^\s*(?:product|model|device\s+type)(?:\s+name)?\s*:\s*(.+?)\s*$")
_ID_VERSION = re.compile(r"(?im)^\s*(?:software\s+)?version\s*:\s*(.+?)\s*$")


class WriteRefused(Exception):
    """A escrita foi recusada antes de qualquer comando chegar ao equipamento."""


def safe(value, what: str) -> str:
    """Só entra na CLI valor que casa com um conjunto fechado de caracteres (anti-injeção de comando)."""
    text = str(value)
    if not _SAFE.match(text):
        raise ValueError(f"{what} inválido para a CLI: {text!r}")
    return text


def parse_identity(text: str) -> tuple[Optional[str], Optional[str]]:
    """Modelo e firmware de um 'show version' em formato rótulo: valor. Formato desconhecido -> (None, None), o que
    mantém a escrita travada (fail-closed) até o firmware daquele equipamento ser homologado."""
    p, v = _ID_PRODUCT.search(text or ""), _ID_VERSION.search(text or "")
    return (p.group(1) if p else None), (v.group(1) if v else None)


def require_write(allow_writes: bool, expected_product, expected_firmware, product, firmware):
    """Trava de escrita comum: exige opt-in local E modelo/firmware lidos do equipamento iguais aos aprovados."""
    if not allow_writes:
        raise WriteRefused("escrita OLT desabilitada na configuração local")
    if not expected_product or not expected_firmware:
        raise WriteRefused("escrita OLT exige modelo e firmware esperados explícitos na configuração local")
    if product != expected_product or firmware != expected_firmware:
        raise WriteRefused(f"modelo/firmware não coincide com a capacidade aprovada localmente ({product!r} / {firmware!r})")


def free_id(used, first: int = 1, last: int = 128) -> int:
    """Menor ID livre na PON (o equipamento aceita IDs dentro da faixa do modelo)."""
    taken = set(used)
    for i in range(first, last + 1):
        if i not in taken:
            return i
    raise WriteRefused("PON cheia: não há ID livre para a ONU")


@dataclass
class OnuState:
    authorized: bool
    pon_port: Optional[str] = None
    line_profile: Optional[str] = None
    service_vlan: Optional[int] = None
    description: Optional[str] = None
    online: Optional[bool] = None
    rx_dbm: Optional[float] = None      # potência óptica recebida pela ONU
    tx_dbm: Optional[float] = None
    extra: dict = field(default_factory=dict)
    service_profile: Optional[str] = None

    @property
    def applied_version(self) -> Optional[int]:
        return version_from_description(self.description)


class OltDriver(Protocol):
    simulated: bool

    def check(self) -> dict: ...
    def discover(self) -> list[dict]: ...                       # ONUs vistas e não autorizadas: serial, pon_port, vendor, model
    def read_onu(self, serial: str) -> OnuState: ...
    def authorize(self, serial: str, *, pon_port: str, line_profile: str, service_vlan: int, description: str, service_profile: Optional[str] = None) -> dict: ...
    def deauthorize(self, serial: str) -> dict: ...
