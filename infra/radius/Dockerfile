# Servidor RADIUS integrado do NexoISP. Sobe junto com o sistema e lê o banco do próprio NexoISP: o provedor não instala nada.
# Só copia configuração (sem instalar pacotes): a imagem base já traz o driver do PostgreSQL.
# FreeRADIUS 3.2.10, imagem efetivamente usada no laboratório UDP.
FROM freeradius/freeradius-server@sha256:337856ea35b77472f15dad159064ce46219a54b499bef5f6a7cba38aefd39fe9
COPY sql /etc/raddb/mods-available/sql
COPY queries.conf /etc/raddb/mods-config/sql/main/postgresql/queries.conf
COPY clients.conf /etc/raddb/clients.conf
COPY nexo-clients /etc/raddb/sites-available/nexo-clients
COPY nexo-cache-desconhecidos /etc/raddb/mods-enabled/nexo-cache-desconhecidos
COPY entrypoint.sh /nexo-entrypoint.sh
# Uso simultâneo por login: a seção "session" consulta o accounting (vem comentada na configuração padrão)
RUN sed -i '/Simultaneous Use Checking Queries/{n;s/^#[[:space:]]*sql$/sql/}' /etc/raddb/sites-available/default \
 && grep -A1 "Simultaneous Use Checking Queries" /etc/raddb/sites-available/default | grep -qx "sql"
ENTRYPOINT ["sh", "/nexo-entrypoint.sh"]
