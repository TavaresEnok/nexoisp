#!/usr/bin/env bash
# Pacote AUTENTICADO do agente (ADR-009): imagem exportada + manifesto assinado (Ed25519, openssl).
#   agent-release.sh keygen <dir>                  -> gera chave de release (guardar a privada FORA dos sites)
#   agent-release.sh build <versao> <chave.pem> <dir_saida>
#   agent-release.sh install <pacote.tar> <chave_publica.pem>   -> no site: verifica assinatura e SHA-256 ANTES de carregar
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-}" in
  keygen)
    mkdir -p "$2"; openssl genpkey -algorithm ed25519 -out "$2/agent-release.key"; chmod 600 "$2/agent-release.key"
    openssl pkey -in "$2/agent-release.key" -pubout -out "$2/agent-release.pub"; echo "chaves em $2 (distribua somente a .pub)" ;;
  build)
    ver="$2"; key="$3"; out="$4"; mkdir -p "$out"
    docker build -q -t "nexoisp-agent:$ver" "$ROOT/services/network-agent" >/dev/null
    docker save "nexoisp-agent:$ver" -o "$out/nexoisp-agent-$ver.tar"
    proto="$(grep -o 'SCHEMA_VERSION = [0-9]*' "$ROOT/services/network-agent/nexo_agent/envelope.py" | grep -o '[0-9]*')"
    local_schema="$(grep -o 'LOCAL_SCHEMA_VERSION = [0-9]*' "$ROOT/services/network-agent/nexo_agent/store.py" | grep -o '[0-9]*')"
    printf 'file=nexoisp-agent-%s.tar\nversion=%s\nsha256=%s\nprotocol_schema=%s\nlocal_schema=%s\n' "$ver" "$ver" \
      "$(sha256sum "$out/nexoisp-agent-$ver.tar" | cut -d' ' -f1)" "$proto" "$local_schema" > "$out/nexoisp-agent-$ver.manifest"
    openssl pkeyutl -sign -inkey "$key" -rawin -in "$out/nexoisp-agent-$ver.manifest" -out "$out/nexoisp-agent-$ver.manifest.sig"
    echo "pacote: $out/nexoisp-agent-$ver.{tar,manifest,manifest.sig}" ;;
  install)
    tar="$2"; pub="$3"; man="${tar%.tar}.manifest"
    openssl pkeyutl -verify -pubin -inkey "$pub" -rawin -in "$man" -sigfile "$man.sig" >/dev/null || { echo "ERRO: assinatura do manifesto inválida; pacote NÃO instalado"; exit 1; }
    want="$(grep '^sha256=' "$man" | cut -d= -f2)"; got="$(sha256sum "$tar" | cut -d' ' -f1)"
    [ "$want" = "$got" ] || { echo "ERRO: SHA-256 do pacote não confere com o manifesto assinado; NÃO instalado"; exit 1; }
    docker load -q -i "$tar"; cat "$man"
    echo "imagem carregada. Próximo passo (site): backup de ./data, ajustar a tag no compose e 'docker compose up -d agent'." ;;
  *) sed -n '2,5p' "$0"; exit 1 ;;
esac
