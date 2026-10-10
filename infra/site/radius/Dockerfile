# RADIUS local do provedor — FreeRADIUS 3.2 lendo SQLite gravado pelo agente.
# Candidato EXPERIMENTAL da prova técnica (ADR-005); avaliar distribuição/licença antes de entregar a terceiros.
FROM freeradius/freeradius-server:latest-3.2
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 && rm -rf /var/lib/apt/lists/*
COPY sql /etc/raddb/mods-available/sql
COPY clients.conf /etc/raddb/clients.conf
COPY entrypoint.sh /nexo-entrypoint.sh
RUN groupadd -g 10001 nexodata && usermod -aG nexodata freerad && ln -sf ../mods-available/sql /etc/raddb/mods-enabled/sql && chmod +x /nexo-entrypoint.sh
ENTRYPOINT ["/nexo-entrypoint.sh"]
CMD ["freeradius", "-f", "-l", "stdout"]
