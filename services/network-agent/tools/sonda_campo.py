#!/usr/bin/env python3
"""Sonda de campo SÓ-LEITURA das OLTs reais (validação dos drivers do NexoISP).

Objetivo: ver como as OLTs de verdade (Huawei, ZTE, VSOL, FiberHome, Datacom...) respondem aos comandos de CONSULTA
que o NexoISP usa, sem alterar nada. Para Huawei, roda o nosso próprio driver (check/discover/leitura de ONU/export de
config) contra o equipamento; para os outros fabricantes, captura a saída crua dos comandos de `show`/`display` para a
gente construir o driver depois.

NUNCA escreve na OLT: há uma trava que recusa qualquer comando mutante (config/undo/add/delete/set/write/reboot...).
Só executa comandos de leitura. A chave SSH do host é capturada e fixada num known_hosts próprio da rodada, para a
conexão usar o mesmo transporte pinado do agente de produção.

Saída crua (pode conter SN/IP/nome de cliente) vai para --out, FORA do repositório. Nada é copiado para o git nem para
a memória. O resumo impresso traz só contagens, modelo/firmware e se o nosso parser entendeu.

Uso:
    python -m tools.sonda_campo inventario.json --out /tmp/sonda-campo

inventario.json = lista de equipamentos:
    [
      {"name": "olt-teste-1", "vendor": "huawei", "host": "10.0.0.10", "username": "u", "password": "p",
       "transport": "ssh", "ssh_profile": "legacy", "enable_password": "...", "commands": ["display board 0"]},
      {"name": "olt-teste-zte", "vendor": "zte", "host": "10.0.0.20", "username": "u", "password": "p",
       "transport": "telnet", "allow_telnet": true, "commands": ["show gpon onu uncfg", "show card"]}
    ]
"""
import argparse
import json
import os
import re
import sys
import traceback
from datetime import datetime, timezone

# Rodar como `python -m tools.sonda_campo` (a raiz do pacote é o diretório do agente).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nexo_agent import cli_transport
from nexo_agent.ssh_trust import LEGACY_ALGORITHMS, fingerprint, host_label
from nexo_agent.drivers import olt_huawei

# Trava de segurança: só comandos de leitura. Qualquer prefixo mutante é recusado antes de ir para o equipamento.
_MUTANTE = re.compile(
    r"^\s*(config|conf\s+t|configure|undo\b|no\b|add\b|del(ete)?\b|set\b|write\b|save\b|reload\b|reset\b|"
    r"commit\b|create\b|modify\b|remove\b|clear\b|erase\b|format\b|reboot\b|shutdown\b|restart\b|upgrade\b|"
    r"service-port\b|ont\s+(add|delete|modify)\b)",
    re.I,
)

# Comandos de leitura padrão por fabricante (ponto de partida; a gente refina vendo a saída real).
_PADRAO = {
    "huawei": ["display version", "display board 0"],
    "zte": ["show version", "show card", "show gpon onu state", "show gpon onu uncfg"],
    "vsol": ["show version", "show card", "show onu unauth"],
    "fiberhome": ["show version", "show card", "show onu unauthorized all"],
    "datacom": ["show version", "show interface gpon", "show running-config"],
    "intelbras": ["show version", "show onu unauthorized"],
    "parks": ["show version"],
}
# fabricante -> device_type do netmiko (o cli_transport mapeia o sufixo _telnet quando o transporte é telnet).
_DEVICE_TYPE = {
    "huawei": "huawei_smartax",
    "zte": "zte_zxros",
    "vsol": "generic",
    "fiberhome": "generic",
    "datacom": "cisco_ios",
    "intelbras": "generic",
    "parks": "generic",
}


def _read_only(commands):
    for c in commands:
        if _MUTANTE.match(c):
            raise ValueError(f"comando recusado pela trava de leitura: {c!r}")
    return commands


def _pin_host_key(entry, known_hosts_path):
    """Captura a chave SSH do host (TOFU na primeira visita) e grava no known_hosts da rodada. Devolve a fingerprint."""
    import paramiko

    legacy = (entry.get("ssh_profile") or "modern") == "legacy"
    sock = paramiko.Transport((entry["host"], int(entry.get("port") or 22)))
    try:
        if legacy:
            # Firmwares antigos só negociam algoritmos legados; para capturar a chave precisamos oferecê-los.
            opts = sock.get_security_options()
            for attr, chave in (("kex", "kex"), ("ciphers", "ciphers"), ("digests", "macs")):
                valores = LEGACY_ALGORITHMS.get(chave)
                if valores:
                    try:
                        setattr(opts, attr, tuple(valores) + tuple(getattr(opts, attr)))
                    except Exception:
                        pass
        sock.start_client(timeout=15)
        key = sock.get_remote_server_key()
    finally:
        sock.close()
    keys = paramiko.HostKeys()
    if os.path.exists(known_hosts_path):
        keys.load(known_hosts_path)
    keys.add(host_label(entry["host"], int(entry.get("port") or 22)), key.get_name(), key)
    os.makedirs(os.path.dirname(known_hosts_path), exist_ok=True)
    keys.save(known_hosts_path)
    os.chmod(known_hosts_path, 0o600)
    return fingerprint(key)


def _cred(entry, known_hosts_path):
    cred = {
        "username": entry["username"],
        "password": entry.get("password", ""),
        "transport": entry.get("transport", "ssh"),
        "known_hosts_file": known_hosts_path,
    }
    for k in ("ssh_profile", "allow_telnet", "enable_password", "user_vlan", "line_profiles", "gemport"):
        if k in entry:
            cred[k] = entry[k]
    return cred


def _run_raw(entry, cred, commands, raw_dir):
    """Fabricante SEM driver: modo RECONHECIMENTO. Conecta direto pelo netmiko (telnet ou SSH) e roda só comandos de
    leitura, salvando a saída crua para a gente estudar o formato e construir o driver depois. Sem fixar chave de host
    (é descoberta); a trava de comando mutante continua valendo."""
    from netmiko import ConnectHandler
    base = entry.get("device_type") or _DEVICE_TYPE.get(entry["vendor"], "generic")
    telnet = (entry.get("transport") or "ssh") == "telnet"
    dtype = base + "_telnet" if telnet and not base.endswith("_telnet") else base
    port = int(entry.get("port") or (23 if telnet else 22))
    kw = dict(device_type=dtype, host=entry["host"], port=port, username=entry["username"],
              password=entry.get("password", ""), fast_cli=False, conn_timeout=25, auth_timeout=25, banner_timeout=25)
    if entry.get("enable_password"):
        kw["secret"] = entry["enable_password"]
    if not telnet and entry.get("ssh_profile") == "legacy":
        kw["disabled_algorithms"] = {}  # aceita algoritmos antigos no reconhecimento
    conn = ConnectHandler(**kw)
    captured = {}
    try:
        try:
            conn.enable()
        except Exception:
            pass
        for c in commands:
            try:
                out = conn.send_command(c, read_timeout=120, cmd_verify=False)
            except Exception as e:
                out = f"<ERRO ao executar: {e}>"
            captured[c] = out
            with open(os.path.join(raw_dir, _slug(c) + ".txt"), "w") as f:
                f.write(out)
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass
    return {"commands": list(captured), "bytes": {c: len(v) for c, v in captured.items()}}


def _run_huawei(entry, cred, extra, raw_dir):
    """Huawei: roda o NOSSO driver (tudo só-leitura) e confere se os parsers entendem a OLT real."""
    dev = {"driver": "olt_huawei", "host": entry["host"], "api_port": entry.get("port"),
           "credential_ref": "sonda", "name": entry.get("name", entry["host"])}
    driver = olt_huawei.HuaweiOltDriver.from_device(dev, {"sonda": cred})
    result = {}

    def step(name, fn):
        try:
            result[name] = fn()
        except Exception as e:
            result[name] = {"erro": str(e), "trace": traceback.format_exc(limit=3)}

    step("check", lambda: driver.check())
    step("autofind", lambda: driver.discover())
    # Amostra: lê o estado/sinal de até 3 ONUs aguardando autorização (ou dos serials informados).
    serials = entry.get("serials") or [o["serial"] for o in (result.get("autofind") or []) if isinstance(o, dict)][:3]

    def leituras():
        out = []
        for sn in serials[:3]:
            try:
                st = driver.read_onu(sn)
                out.append({"serial": sn, "authorized": st.authorized, "online": st.online,
                            "rx_dbm": st.rx_dbm, "tx_dbm": st.tx_dbm, "pon_port": st.pon_port,
                            "line_profile": st.line_profile, "service_vlan": st.service_vlan})
            except Exception as e:
                out.append({"serial": sn, "erro": str(e)})
        return out

    step("leitura_onu", leituras)

    def export():
        cfg = driver.export_config()
        with open(os.path.join(raw_dir, "current-configuration.txt"), "w") as f:
            f.write(cfg)
        return {"bytes": len(cfg.encode()), "linhas": cfg.count("\n"),
                "tem_ont_add": "ont add" in cfg, "tem_service_port": "service-port" in cfg}

    step("export_config", export)

    # Comandos extras de leitura, pela sessão do próprio driver (mesma paginação/transporte).
    if extra:
        raw = {}
        try:
            with driver._session() as s:
                for c in extra:
                    raw[c] = s.run(c, tolerate=True)
                    with open(os.path.join(raw_dir, _slug(c) + ".txt"), "w") as f:
                        f.write(raw[c])
        except Exception as e:
            result["extra_erro"] = str(e)
        result["extra_bytes"] = {c: len(v) for c, v in raw.items()}
    try:
        driver._drop()
    except Exception:
        pass
    return result


def _slug(cmd):
    return re.sub(r"[^A-Za-z0-9]+", "_", cmd).strip("_")[:60] or "cmd"


def sondar(entry, out_dir):
    name = entry.get("name") or entry["host"]
    raw_dir = os.path.join(out_dir, _slug(name))
    os.makedirs(raw_dir, exist_ok=True)
    info = {"name": name, "vendor": entry["vendor"], "host": entry["host"],
            "transport": entry.get("transport", "ssh"), "ssh_profile": entry.get("ssh_profile")}
    try:
        known_hosts = os.path.join(out_dir, "known_hosts")
        cred = _cred(entry, known_hosts)
        if cred["transport"] == "ssh" and entry["vendor"] == "huawei":
            info["host_key_fingerprint"] = _pin_host_key(entry, known_hosts)
        commands = _read_only(entry.get("commands") or _PADRAO.get(entry["vendor"], []))
        if entry["vendor"] == "huawei":
            info["resultado"] = _run_huawei(entry, cred, commands, raw_dir)
        else:
            info["resultado"] = _run_raw(entry, cred, commands, raw_dir)
        info["ok"] = True
    except Exception as e:
        info["ok"] = False
        info["erro"] = str(e)
        info["trace"] = traceback.format_exc(limit=4)
    info["raw_dir"] = raw_dir
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inventario", help="JSON com a lista de equipamentos (host, credencial, comandos)")
    ap.add_argument("--out", default=f"/tmp/sonda-campo-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}",
                    help="pasta da saída crua (FORA do repositório; padrão em /tmp)")
    args = ap.parse_args()
    with open(args.inventario) as f:
        inventario = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    resumo = []
    for entry in inventario:
        print(f"== {entry.get('name') or entry['host']} ({entry['vendor']}) ...", flush=True)
        r = sondar(entry, args.out)
        resumo.append(r)
        print("   ok" if r["ok"] else f"   FALHA: {r.get('erro')}", flush=True)
    # Resumo sem conteúdo cru: seguro para colar/analisar.
    seguro = []
    for r in resumo:
        s = {k: r[k] for k in ("name", "vendor", "transport", "ssh_profile", "ok", "erro", "host_key_fingerprint") if k in r}
        res = r.get("resultado", {})
        if r["vendor"] == "huawei" and isinstance(res, dict):
            chk = res.get("check", {})
            s["identidade"] = {k: chk.get(k) for k in ("product", "firmware", "ok") if isinstance(chk, dict)}
            s["autofind_qtd"] = len(res["autofind"]) if isinstance(res.get("autofind"), list) else res.get("autofind")
            s["leitura_onu"] = res.get("leitura_onu")
            s["export_config"] = res.get("export_config")
        else:
            s["comandos"] = res.get("commands")
            s["bytes_por_comando"] = res.get("bytes")
        seguro.append(s)
    with open(os.path.join(args.out, "resumo.json"), "w") as f:
        json.dump(seguro, f, ensure_ascii=False, indent=2)
    print("\n=== RESUMO (sem conteúdo cru) ===")
    print(json.dumps(seguro, ensure_ascii=False, indent=2))
    print(f"\nSaída crua em: {args.out}  (não vai para o git)")


if __name__ == "__main__":
    main()
