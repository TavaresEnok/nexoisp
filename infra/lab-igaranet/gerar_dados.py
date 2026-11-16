#!/usr/bin/env python3
"""Gera os 30 assinantes FICTÍCIOS do provedor de laboratório IgaraNet (Igarassu-PE).

Tudo aqui é inventado: nomes, documentos (CPF com dígito verificador válido, gerado a partir de semente fixa),
endereços aproximados e coordenadas espalhadas por bairros de Igarassu. Serial de ONU, MAC do "roteador" do cliente,
login e senha PPPoE são do laboratório. Saída: clientes.json (lido pelo nó da OLT, pelo nó dos clientes e pelo cadastro).
"""
import json
import random
from pathlib import Path

rnd = random.Random(20261116)

NOMES = ["Ana", "Bruno", "Carla", "Diego", "Elaine", "Fábio", "Gabriela", "Heitor", "Isabela", "João", "Kátia", "Lucas", "Marta",
         "Nilton", "Olívia", "Paulo", "Quitéria", "Rafael", "Sandra", "Tiago", "Úrsula", "Vinícius", "Wanda", "Xavier", "Yara",
         "Zélia", "Arthur", "Beatriz", "Caio", "Débora"]
SOBRENOMES = ["Albuquerque", "Barbosa", "Cavalcanti", "Duarte", "Ferraz", "Gouveia", "Holanda", "Lacerda", "Maranhão", "Nóbrega",
              "Pessoa", "Queiroga", "Rego", "Siqueira", "Tavares", "Uchôa", "Vasconcelos", "Wanderley"]
# Bairros de Igarassu com um ponto central aproximado (lat, lng) e ruas fictícias para os endereços.
BAIRROS = [
    ("Centro", -7.8343, -34.9063, ["Rua Barbosa Lima", "Rua da Matriz", "Travessa do Rosário"]),
    ("Cruz de Rebouças", -7.8155, -34.9240, ["Rua Projetada A", "Rua do Canal", "Avenida Principal"]),
    ("Saramandaia", -7.8290, -34.9135, ["Rua São Sebastião", "Rua das Flores"]),
    ("Santo Antônio", -7.8395, -34.9010, ["Rua Santo Antônio", "Rua do Comércio"]),
    ("Agamenon Magalhães", -7.8235, -34.9065, ["Rua Agamenon", "Rua Nova"]),
    ("Triunfo", -7.8440, -34.9150, ["Rua do Triunfo", "Rua Esperança"]),
]
PLANOS = ["IgaraNet 300 Mega", "IgaraNet 500 Mega", "IgaraNet 700 Mega"]


def cpf(rng: random.Random) -> str:
    n = [rng.randint(0, 9) for _ in range(9)]
    for k in (10, 11):
        s = sum(d * (k - i) for i, d in enumerate(n)) % 11
        n.append(0 if s < 2 else 11 - s)
    return "".join(map(str, n))


MAES = ["Maria", "Josefa", "Antônia", "Francisca", "Severina", "Luzia", "Rita", "Edna", "Socorro", "Lúcia", "Graça", "Fátima"]
REFERENCIAS = ["Próximo à igreja", "Em frente à padaria", "Casa de muro azul", "Ao lado do mercadinho", "Portão de ferro preto",
               "Primeiro andar", "Vila com portão verde", "Perto da escola municipal", "Esquina com farmácia", "Fundos, entrar pelo beco"]


def completar(out):
    """Campos adicionais (semente própria, para não alterar os dados já cadastrados): nascimento, RG, mãe, contatos,
    referência do endereço, cliente desde e preferência de vencimento."""
    r = random.Random(1611)
    for c in out:
        sob = c["nome"].split()[-1]
        c["nascimento"] = f"{r.randint(1958, 2003)}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}"
        c["rg"] = f"{r.randint(1, 9)}.{r.randint(100, 999)}.{r.randint(100, 999)}"
        c["rg_orgao"] = "SDS/PE"
        c["mae"] = f"{r.choice(MAES)} {r.choice(SOBRENOMES)} {sob}"
        c["whatsapp"] = c["telefone"]
        c["telefone_fixo"] = f"81 3543-{r.randint(1000, 9999)}" if r.random() < 0.3 else None
        c["referencia"] = r.choice(REFERENCIAS)
        # cliente desde: base instalada crescendo de 2023 a 2026 (os mais antigos primeiro)
        ano = 2023 + (c["n"] - 1) * 4 // 30
        c["cliente_desde"] = f"{ano}-{r.randint(1, 12 if ano < 2026 else 10):02d}-{r.randint(1, 28):02d}"
        c["vencimento"] = r.choice([5, 10, 10, 15, 20, 25])
        c["fidelidade"] = r.random() < 0.7


def main():
    out = []
    for i in range(1, 31):
        bairro, lat, lng, ruas = BAIRROS[(i - 1) % len(BAIRROS)]
        s1, s2 = rnd.sample(SOBRENOMES, 2)
        nome = f"{NOMES[i - 1]} {s1} {s2}"
        # Sinal: a maioria entre -17 e -23 dBm; três clientes com problema para testar alertas (atenuação alta na drop).
        rx = {7: -27.4, 18: -28.9, 25: -26.1}.get(i, round(rnd.uniform(-23.0, -17.0), 2))
        out.append({
            "n": i,
            "nome": nome,
            "cpf": cpf(rnd),
            "telefone": f"81 9{rnd.randint(8000, 9999)}-{rnd.randint(1000, 9999)}",
            "email": f"cliente{i:02d}@igaranet.lab",
            "bairro": bairro,
            "logradouro": ruas[rnd.randrange(len(ruas))],
            "numero": str(rnd.randint(10, 999)),
            "cidade": "Igarassu", "uf": "PE", "cep": "53610-000",
            "lat": round(lat + rnd.uniform(-0.0045, 0.0045), 6),
            "lng": round(lng + rnd.uniform(-0.0045, 0.0045), 6),
            "plano": PLANOS[rnd.choice([0, 0, 1, 1, 2])],
            "login": f"igara{i:03d}",
            "senha": f"Igara#{i:03d}{rnd.randint(100, 999)}",
            "serial": f"48575443{0x1A2B0000 + i:08X}",
            "mac": f"02:1a:2b:00:00:{i:02x}",
            "pon": "0/1/0" if i <= 16 else "0/1/1",
            "rx_dbm": rx,
        })
    completar(out)
    Path(__file__).with_name("clientes.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(out)} clientes fictícios gerados")


if __name__ == "__main__":
    main()
