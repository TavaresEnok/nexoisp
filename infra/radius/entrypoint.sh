#!/bin/sh
# Variáveis: RADIUS_DB_HOST, RADIUS_DB_PORT, RADIUS_DB_NAME, RADIUS_DB_PASSWORD (papel nexo_radius), NEXO_RADIUS_KEY (chave das senhas),
# RADIUS_PORT (autenticação; accounting = +1; padrão 1812).
set -e
: "${RADIUS_DB_HOST:?defina RADIUS_DB_HOST}" "${RADIUS_DB_PASSWORD:?defina RADIUS_DB_PASSWORD}" "${NEXO_RADIUS_KEY:?defina NEXO_RADIUS_KEY}"
case "$NEXO_RADIUS_KEY" in *[!A-Za-z0-9_-]*) echo "NEXO_RADIUS_KEY: use só letras, números, _ e -"; exit 1 ;; esac
ln -sf ../mods-available/sql /etc/raddb/mods-enabled/sql
ln -sf ../sites-available/nexo-clients /etc/raddb/sites-enabled/nexo-clients
exec freeradius -f -l stdout -i "${RADIUS_BIND:-0.0.0.0}" -p "${RADIUS_PORT:-1812}" "$@"
