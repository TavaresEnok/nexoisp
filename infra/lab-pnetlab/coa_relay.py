"""Repasse de desconexão (RFC 5176) SÓ para o laboratório do PNETLab.

O Docker deste servidor roda com --iptables=false: o container da API não sai com o endereço do host, e o concentrador só
aceita a desconexão vinda do endereço do servidor RADIUS que ele conhece. Este repasse, na rede do host, recebe o pedido da
API e o reenvia ao concentrador a partir do endereço certo. Em instalação normal (Docker com NAT) ele não é necessário.
Uso: coa_relay.py <escuta_ip> <escuta_porta> <origem_ip> <nas_ip> <nas_porta>
"""
import socket
import sys

listen_ip, listen_port, src_ip, nas_ip, nas_port = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5])
srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
srv.bind((listen_ip, listen_port))
print(f"repasse de desconexão: {listen_ip}:{listen_port} -> {nas_ip}:{nas_port} (origem {src_ip})", flush=True)
while True:
    data, client = srv.recvfrom(4096)
    out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        out.bind((src_ip, 0))
        out.settimeout(3)
        out.sendto(data, (nas_ip, nas_port))
        reply, _ = out.recvfrom(4096)
        srv.sendto(reply, client)
    except OSError as e:          # sem resposta do concentrador: quem pediu trata como tempo esgotado
        print(f"sem resposta do concentrador: {e}", flush=True)
    finally:
        out.close()
