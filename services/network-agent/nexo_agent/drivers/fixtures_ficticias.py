"""Gerador de OLTs FICTÍCIAS para o emulador Huawei, com as distribuições do estudo de campo (docs/estudo-campo/olt-huawei.md).

Nenhum dado real entra aqui: só contagens agregadas. Seriais têm prefixo de fabricante na proporção observada e sufixo
aleatório; descrições e logins são inventados ("FICTICIO"). Serve para exercitar o driver e o motor com uma OLT do
tamanho e da bagunça de uma OLT de verdade (PON cheia, IDs com buracos, VLAN por PON, gemport variado, ONUs offline).

Uso:  python -m nexo_agent.drivers.fixtures_ficticias <estado.json> [--seed N] [--pons N]
      python -m nexo_agent.drivers.olt_huawei_emulator 2222 <estado.json>
"""
import argparse
import bisect
import json
import random

# ONTs por PON: p50 = 29, p90 = 80, p95 = 94, p99 = 117, máx = 128 (pontos da distribuição acumulada).
_ONTS_POR_PON = [(0.0, 1), (0.25, 12), (0.50, 29), (0.75, 55), (0.90, 80), (0.95, 94), (0.99, 117), (1.0, 128)]
# Prefixo do serial (fabricante) ponderado; sufixo sempre aleatório.
_FABRICANTES = [("HWTC", 0.78), ("ZTEG", 0.06), ("FHTT", 0.04), ("ITBS", 0.04), ("TPLG", 0.03), ("PRKS", 0.02), ("ALCL", 0.02), ("GPON", 0.01)]
# gemport do service-port: 100: 56,6% · 400: 16,8% · 1: 9,4% · 500: 4,3% · 600: 2,6% · 10: 2,1% · 300: 1,6%.
_GEMPORTS = [(100, 0.566), (400, 0.168), (1, 0.094), (500, 0.043), (600, 0.026), (10, 0.021), (300, 0.016), (200, 0.066)]
_MODELOS = ["HG8310M", "EG8145V5", "HG8546M", "F601", "F670L", "ONU-GPON-GENERICA"]


def _pick(rng: random.Random, weighted):
    r, acc = rng.random() * sum(w for _, w in weighted), 0.0
    for value, weight in weighted:
        acc += weight
        if r <= acc:
            return value
    return weighted[-1][0]


def _onts_na_pon(rng: random.Random) -> int:
    u = rng.random()
    xs = [p for p, _ in _ONTS_POR_PON]
    i = max(1, bisect.bisect_left(xs, u))
    (p0, v0), (p1, v1) = _ONTS_POR_PON[i - 1], _ONTS_POR_PON[i]
    return max(1, min(128, round(v0 + (v1 - v0) * (u - p0) / (p1 - p0))))


def _serial(rng: random.Random, usados: set) -> str:
    while True:
        prefixo = _pick(rng, _FABRICANTES)
        sn = prefixo.encode().hex().upper() + "".join(rng.choice("0123456789ABCDEF") for _ in range(8))
        if sn not in usados:
            usados.add(sn)
            return sn


def gerar_olt(seed: int = 1, pons: int = 20, pon_cheia: bool = True, vlan_por_pon: bool = True) -> dict:
    """Estado do emulador (formato de OltState.d). Mesma semente, mesma OLT."""
    rng = random.Random(seed)
    usados: set = set()
    onts, sports, offline, vlans = [], [], [], set()
    linha_principal = "line-profile_1"  # 63% das ONTs usam o nome padrão; o perfil mais usado cobre ~93% da OLT
    sp = 0
    portas = [f"0/{1 + i // 16}/{i % 16}" for i in range(pons)]
    cheia = rng.randrange(pons) if pon_cheia and pons >= 8 else None
    for n, fsp in enumerate(portas):
        slot, porta = int(fsp.split("/")[1]), int(fsp.split("/")[2])
        total = 128 if n == cheia else _onts_na_pon(rng)
        ids = list(range(128 if n == cheia else min(128, total + (rng.randrange(1, 6) if rng.random() < 0.4 else 0))))
        if n != cheia:
            # 60% das PONs sem buracos; nas demais, IDs liberados por remoções e ainda não reusados.
            ids = sorted(rng.sample(ids, total)) if len(ids) > total else ids[:total]
        vlan = 1000 + slot * 16 + porta if vlan_por_pon else rng.choice([100, 200, 300])
        vlans.add(vlan)
        for oid in ids:
            sn = _serial(rng, usados)
            linha = linha_principal if rng.random() < 0.93 else f"line-profile_{rng.randrange(2, 7)}"
            onts.append({"fsp": fsp, "id": oid, "sn": sn, "line": linha, "srv": "srv-profile_1" if rng.random() < 0.9 else "srv-profile_2",
                         "desc": f"FICTICIO {rng.randrange(100000):06d} cliente.ficticio{rng.randrange(10000)}", "at": 0})
            sports.append({"index": sp, "vlan": vlan, "fsp": fsp, "ont": oid, "gem": _pick(rng, _GEMPORTS), "user_vlan": 100 if rng.random() < 0.64 else vlan})
            sp += 1
            if rng.random() < 0.05:
                offline.append(sn)
    autofind = [[rng.choice(portas), _serial(rng, usados), "HWTC", rng.choice(_MODELOS)] for _ in range(rng.randrange(0, 4))]
    return {"autofind": autofind, "onts": onts, "sports": sports, "next_sp": sp, "offline": offline,
            "line_profiles": [linha_principal] + [f"line-profile_{i}" for i in range(2, 7)], "srv_profiles": ["srv-profile_1", "srv-profile_2"],
            "vlans": sorted(vlans | {100, 200, 300}), "ficticio": True, "seed": seed}


def main():  # pragma: no cover
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("saida")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--pons", type=int, default=20, help="PONs usadas (mediana real: 20; p90: 55)")
    args = parser.parse_args()
    estado = gerar_olt(args.seed, args.pons)
    with open(args.saida, "w") as f:
        json.dump(estado, f)
    print(f"OLT fictícia: {len(estado['onts'])} ONUs em {args.pons} PONs -> {args.saida}")


if __name__ == "__main__":  # pragma: no cover
    main()
