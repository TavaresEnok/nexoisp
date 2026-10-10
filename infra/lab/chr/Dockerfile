# LABORATÓRIO: MikroTik CHR (RouterOS real) em QEMU/KVM + cliente PPPoE (pppd) no mesmo container.
# ether1 = rede de gerência (NAT do QEMU; API publicada na porta 8728/8729 do container)
# ether2 = segmento L2 dos assinantes (tap0), onde o pppd deste container disca.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends qemu-system-x86 ppp iproute2 iputils-ping procps netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh pppoe-client.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/pppoe-client.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
