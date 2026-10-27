"""Validação do envelope de operação: assinatura Ed25519 sobre os bytes exatos + schema estrito."""
import base64
import json
from datetime import datetime, timezone
from ipaddress import IPv6Network
from typing import Literal, Optional, Union

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 1


class EnvelopeError(Exception):
    pass


class Suspension(BaseModel):
    """reject: nega a autenticação. profile: a conta autentica com o perfil de bloqueio do NAS (agente 0.4.0+)."""
    model_config = ConfigDict(extra="forbid")
    mode: Literal["reject", "profile"]
    session: Literal["disconnect", "keep"]
    profile: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_.-]{1,60}$")

    @model_validator(mode="after")
    def _profile_iff_mode(self):
        if (self.mode == "profile") != (self.profile is not None):
            raise ValueError("suspension.profile é obrigatório no modo 'profile' e proibido no modo 'reject'")
        return self


class Parameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(pattern=r"^[A-Za-z0-9_.@-]{3,64}$")
    profile: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,60}$")
    policy: Literal["active", "suspended"]
    secret_ref: Optional[str] = None
    suspension: Optional[Suspension] = None
    # IP fixo do contrato (IPAM). Ausente = endereço dinâmico do NAS. Agentes anteriores à 0.3.0 recusam o envelope que o traz.
    framed_ip: Optional[str] = Field(default=None, pattern=r"^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$")
    # MAC vinculado à conta (agente 0.4.0+): o RADIUS só autentica a conta vinda desse equipamento. Ausente = sem vínculo.
    mac: Optional[str] = Field(default=None, pattern=r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
    # Agente 0.5.0+. Todos opcionais; ausente = não gravar o atributo (vale o que o perfil do NAS define).
    delegated_ipv6_prefix: Optional[str] = None

    @field_validator("delegated_ipv6_prefix")
    @classmethod
    def _ipv6_prefix(cls, value):
        if value is None:
            return value
        prefix = IPv6Network(value, strict=True)
        if not 48 <= prefix.prefixlen <= 64:
            raise ValueError("prefixo IPv6 deve ter comprimento entre /48 e /64")
        return str(prefix)

    reconnect: Optional[bool] = None          # derrubar a sessão atual mesmo sem mudança de autorização (subscriber.disconnect)
    rate_limit: Optional[str] = Field(default=None, pattern=r"^\d{1,7}[kKmM]?/\d{1,7}[kKmM]?( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?){0,3}( [1-8]( \d{1,7}[kKmM]?/\d{1,7}[kKmM]?)?)?$")
    address_pool: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_.-]{1,60}$")
    simultaneous_use: Optional[int] = Field(default=None, ge=1, le=10)
    acct_interim: Optional[int] = Field(default=None, ge=60, le=3600)


class OnuParameters(BaseModel):
    """Parâmetros das operações de ONU (expansão OLT/ONU)."""
    model_config = ConfigDict(extra="forbid")
    serial: str = Field(pattern=r"^[A-Za-z0-9]{8,20}$")
    pon_port: str = Field(pattern=r"^[0-9]{1,3}(/[0-9]{1,3}){0,3}$")
    line_profile: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,60}$")
    service_profile: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_.-]{1,60}$")
    service_vlan: int = Field(ge=1, le=4094)
    state: Literal["authorized", "removed"]
    description: str = Field(pattern=r"^nexo:[0-9a-f]{8}:v[0-9]+$")


class Authorization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["user", "system"]
    id: str


class Envelope(BaseModel):
    """Catálogo fechado de operações: não existe shell/CLI livre."""
    model_config = ConfigDict(extra="forbid")
    operation_id: str
    tenant_id: str
    resource_id: str
    device_id: str
    agent_id: str
    action: Literal["subscriber.provision", "subscriber.suspend", "subscriber.resume", "subscriber.disconnect", "onu.authorize", "onu.deauthorize"]
    schema_version: int
    desired_version: int = Field(gt=0)
    parameters: Union[Parameters, OnuParameters]
    idempotency_key: str
    valid_until: datetime
    authorization: Authorization


def verify_envelope(raw: str, signature_b64: str, public_key_b64: str, *, agent_id: str, tenant_id: str,
                    device_ids: set[str], now: Optional[datetime] = None) -> Envelope:
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64)).verify(
            base64.b64decode(signature_b64), raw.encode("utf-8"))
    except (InvalidSignature, ValueError) as e:
        raise EnvelopeError("assinatura inválida") from e
    try:
        env = Envelope.model_validate(json.loads(raw))
    except Exception as e:
        raise EnvelopeError(f"envelope fora do schema: {e}") from e
    if env.schema_version != SCHEMA_VERSION:
        raise EnvelopeError(f"schema_version {env.schema_version} não suportada")
    if env.agent_id != agent_id or env.tenant_id != tenant_id:
        raise EnvelopeError("envelope destinado a outro agente/tenant")
    if env.device_id not in device_ids:
        raise EnvelopeError("equipamento não autorizado para este agente")
    is_onu = env.action.startswith("onu.")
    if is_onu != isinstance(env.parameters, OnuParameters):
        raise EnvelopeError("parâmetros incompatíveis com a ação")
    if is_onu:
        if env.parameters.description != f"nexo:{env.resource_id[:8]}:v{env.desired_version}":
            raise EnvelopeError("marcador ONU não corresponde ao recurso/versão assinados")
        if env.parameters.state != {"onu.authorize": "authorized", "onu.deauthorize": "removed"}[env.action]:
            raise EnvelopeError("estado incompatível com a ação")
    else:
        expected = {"subscriber.suspend": "suspended", "subscriber.resume": "active"}.get(env.action)
        if expected and env.parameters.policy != expected:
            raise EnvelopeError("política incompatível com a ação")
        if (env.action == "subscriber.disconnect") != bool(env.parameters.reconnect):
            raise EnvelopeError("reconnect só vale (e é obrigatório) em subscriber.disconnect")
    if env.valid_until <= (now or datetime.now(timezone.utc)):
        raise EnvelopeError("envelope vencido")
    return env
