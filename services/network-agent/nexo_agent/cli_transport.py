"""Transporte CLI dos equipamentos (OLTs): SSH moderno, SSH legado e telnet.

O padrão é SSH moderno com chave do equipamento fixada (ssh_trust). As outras formas existem porque boa parte das OLTs
em campo só fala SSH antigo ou telnet (docs/estudo-campo). Cada uma é ligada por equipamento, na credencial local do
agente, nunca como recuo automático:

    "transport": "ssh" | "telnet"        (padrão ssh)
    "ssh_profile": "modern" | "legacy"   (padrão modern; legacy aceita SHA-1, CBC/3DES, ssh-rsa e ssh-dss)
    "allow_telnet": true                 (obrigatório com transport=telnet: login e senha trafegam em claro)
    "enable_password": "..."             (opcional, para firmwares que pedem senha no enable)

Com telnet não existe verificação de identidade do equipamento; use só em rede de gerência isolada.
"""
import logging

from .ssh_trust import ssh_parameters

log = logging.getLogger(__name__)

TRANSPORTS = ("ssh", "telnet")
SSH_PROFILES = ("modern", "legacy")
# O netmiko escolhe o protocolo pelo sufixo do device_type.
_TELNET_TYPES = {"huawei_smartax": "huawei_olt_telnet", "zte_zxros": "zte_zxros_telnet", "cisco_ios": "cisco_ios_telnet"}


def settings(cred: dict) -> dict:
    """Valida as opções de transporte da credencial. Valor desconhecido é erro, nunca o padrão silencioso."""
    transport = cred.get("transport") or "ssh"
    profile = cred.get("ssh_profile") or "modern"
    if transport not in TRANSPORTS:
        raise ValueError(f"transport deve ser um de {TRANSPORTS} (recebido: {transport!r})")
    if profile not in SSH_PROFILES:
        raise ValueError(f"ssh_profile deve ser um de {SSH_PROFILES} (recebido: {profile!r})")
    if transport == "telnet":
        if cred.get("allow_telnet") is not True:
            raise ValueError("telnet exige \"allow_telnet\": true na credencial local (login e senha trafegam em claro)")
        if cred.get("ssh_profile"):
            raise ValueError("ssh_profile não se aplica a telnet")
    return {"transport": transport, "ssh_profile": profile if transport == "ssh" else None}


def default_port(cred: dict) -> int:
    return 23 if settings(cred)["transport"] == "telnet" else 22


def note(cred: dict) -> str:
    """Aviso exibido junto ao estado do equipamento quando o acesso não é SSH moderno."""
    s = settings(cred)
    if s["transport"] == "telnet":
        return "acesso por telnet: login e senha trafegam em claro"
    if s["ssh_profile"] == "legacy":
        return "SSH com algoritmos antigos (SHA-1/CBC)"
    return ""


def hygiene(cred: dict) -> list[str]:
    """Códigos de prática de gerência ligados ao acesso, informados ao NOC."""
    s = settings(cred)
    if s["transport"] == "telnet":
        return ["telnet_transport"]
    return ["legacy_ssh"] if s["ssh_profile"] == "legacy" else []


def connect(device_type: str, host: str, port: int, username: str, password: str, cred: dict, **timeouts):
    """Abre a sessão netmiko conforme a credencial. A chave fixada vale para os dois perfis SSH."""
    from netmiko import ConnectHandler
    s = settings(cred)
    common = dict(host=host, port=port, username=username, password=password, secret=cred.get("enable_password") or "", **timeouts)
    if s["transport"] == "telnet":
        if device_type not in _TELNET_TYPES:
            raise ValueError(f"telnet não suportado para {device_type}")
        log.warning("conectando a %s:%s por telnet (credencial em claro na rede)", host, port)
        return ConnectHandler(device_type=_TELNET_TYPES[device_type], **common)
    security = ssh_parameters(host, port, cred.get("known_hosts_file") or "", legacy=s["ssh_profile"] == "legacy")
    return ConnectHandler(device_type=device_type, **common, **security)
