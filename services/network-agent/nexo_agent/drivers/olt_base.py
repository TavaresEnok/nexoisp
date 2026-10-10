"""Contrato dos drivers de OLT (expansão OLT/ONU). Um fabricante/modelo/firmware por driver; nada de CLI livre."""
import re
from dataclasses import dataclass, field
from typing import Optional, Protocol

_MARK = re.compile(r"^nexo:[0-9a-f]{8}:v(\d+)$")


def version_from_description(description: Optional[str]) -> Optional[int]:
    """A descrição gravada na ONU carrega a versão da intenção: permite saber, lendo a OLT, qual operação produziu o estado."""
    m = _MARK.match(description or "")
    return int(m.group(1)) if m else None


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
