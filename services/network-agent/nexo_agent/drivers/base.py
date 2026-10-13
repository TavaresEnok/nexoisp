"""Contrato dos drivers. Cada driver cobre autorização local (RADIUS) + sessões no NAS para UM tipo homologado."""
from dataclasses import dataclass, field
from typing import Optional, Protocol


class AckLost(Exception):
    """O comando foi enviado, mas a confirmação não chegou: o efeito PODE ter ocorrido."""


@dataclass
class AccountState:
    exists: bool
    policy: str = "absent"            # active | suspended | absent
    profile: Optional[str] = None
    applied_version: Optional[int] = None   # versão da intenção gravada junto da autorização (distingue o efeito de cada operação)
    session: Optional[dict] = None    # sessão conhecida no NAS, se houver
    extra: dict = field(default_factory=dict)
    framed_ip: Optional[str] = None   # IP fixo que o RADIUS local entrega (None = dinâmico)
    mac: Optional[str] = None         # MAC vinculado à conta (None = sem vínculo)
    attrs: dict = field(default_factory=dict)   # atributos opcionais gravados (rate_limit, address_pool, simultaneous_use, acct_interim)


class Driver(Protocol):
    simulated: bool

    def check(self) -> dict: ...
    def read(self, username: str) -> AccountState: ...
    def apply_authorization(self, username: str, *, secret: Optional[str], profile: str, policy: str, version: int, framed_ip: Optional[str] = None,
                            block_profile: Optional[str] = None, mac: Optional[str] = None, extra: Optional[dict] = None) -> dict: ...
    def disconnect(self, username: str) -> dict: ...
