#!/usr/bin/env bash
# Gera SBOMs CycloneDX separados do módulo apps/api-go e do workspace npm da raiz.
# Instala só ferramentas oficiais pinadas, fora do repositório, e confere a integridade.
# Não altera go.mod, go.sum, package-lock.json nem versões do produto.
# Não lê .env, credenciais, dados de clientes ou produção.
# Documentação: docs/SBOM.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${1:-$ROOT/sbom}"

# Release oficial CycloneDX/cyclonedx-gomod v1.12.0 (22/08/2026).
# O SHA-256 é o digest do asset no GitHub Releases.
GOMOD_VERSION=1.12.0
GOMOD_SHA_AMD64=004b9f5cc595b797fb5423e2ae4c97bcf0f18c712ed2faee1640b09e5efd6d15
GOMOD_SHA_ARM64=b6dd6424755e61c0f7fcd36074fbb78798a33c52f1bd35dd177ba62eccadf404

# Pacote oficial @cyclonedx/cyclonedx-npm 6.0.1 no registry.npmjs.org.
# A integridade é o dist.integrity publicado pelo registro.
NPM_TOOL_VERSION=6.0.1
NPM_TOOL_INTEGRITY='sha512-/aU3bBC6qP6cV/qQ5SfUSygE/+2hQhwgg6sJML31/gZ96NyMvIUuwdk637H4z+LS/NryRT2kjR2wtD0qBEVVHQ=='
NPM_TOOL_URL="https://registry.npmjs.org/@cyclonedx/cyclonedx-npm/-/cyclonedx-npm-${NPM_TOOL_VERSION}.tgz"

GO_SCOPE='Grafo de módulos de apps/api-go, incluindo dependências de teste. Escopo de fonte e build local. Este SBOM não comprova imagem publicada, homologação ou deploy.'
NPM_SCOPE='package-lock.json do workspace npm na raiz (apps/web), incluindo dependências de build. Não inclui e2e nem apps/web-legacy. Escopo de fonte e build local. Este SBOM não comprova imagem publicada, homologação ou deploy.'

CACHE="${NEXO_SBOM_TOOL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/nexoisp-sbom}"
case "$CACHE" in
  "$ROOT"|"$ROOT"/*) echo "ERRO: o cache das ferramentas não pode ficar dentro do repositório" >&2; exit 1 ;;
esac

die() { echo "ERRO: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "comando ausente: $1"; }
for cmd in go node npm python3 curl sha256sum tar git; do need "$cmd"; done

commit="$(git rev-parse HEAD)"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "commit HEAD inválido"
if [[ -n "${GITHUB_ACTIONS:-}" && -z "${GITHUB_RUN_ID:-}" ]]; then
  die "GITHUB_ACTIONS sem GITHUB_RUN_ID"
fi
run_id="${NEXO_SBOM_RUN_ID:-${GITHUB_RUN_ID:-local}}"
if [[ -n "${GITHUB_RUN_ATTEMPT:-}" && "$run_id" != "local" ]]; then
  run_id="${run_id}.attempt${GITHUB_RUN_ATTEMPT}"
fi
[[ "$run_id" =~ ^[A-Za-z0-9._:-]+$ ]] || die "identificação de run inválida"

go_tc="$(go version)"
node_tc="$(node --version)"
npm_tc="$(npm --version)"
[[ "$go_tc" == go\ version\ go* ]] || die "toolchain Go ilegível: $go_tc"
[[ "$node_tc" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "toolchain Node ilegível: $node_tc"
[[ "$npm_tc" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "toolchain npm ilegível: $npm_tc"

work="$(mktemp -d "${TMPDIR:-/tmp}/nexo-sbom-out.XXXXXX")"
dl="$(mktemp -d "${TMPDIR:-/tmp}/nexo-sbom-dl.XXXXXX")"
cleanup() { rm -rf "$work" "$dl"; }
trap cleanup EXIT

install_gomod() {
  local sha archive arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) sha="$GOMOD_SHA_AMD64"; archive="cyclonedx-gomod_${GOMOD_VERSION}_linux_amd64.tar.gz" ;;
    aarch64|arm64) sha="$GOMOD_SHA_ARM64"; archive="cyclonedx-gomod_${GOMOD_VERSION}_linux_arm64.tar.gz" ;;
    *) die "arquitetura sem binário oficial pinado: $arch" ;;
  esac
  GOMOD_DIR="$CACHE/cyclonedx-gomod-${GOMOD_VERSION}-${arch}"
  GOMOD_BIN="$GOMOD_DIR/cyclonedx-gomod"
  if [[ -x "$GOMOD_BIN" && "$(cat "$GOMOD_DIR/PIN" 2>/dev/null || true)" == "$sha" ]]; then
    return 0
  fi
  mkdir -p "$GOMOD_DIR"
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
    -o "$dl/$archive" \
    "https://github.com/CycloneDX/cyclonedx-gomod/releases/download/v${GOMOD_VERSION}/$archive"
  python3 "$ROOT/scripts/validate-sbom.py" integrity --file "$dl/$archive" --expected "sha256-${sha}"
  tar -tzf "$dl/$archive" | grep -qx 'cyclonedx-gomod' || die "release oficial sem o binário cyclonedx-gomod"
  tar -xzf "$dl/$archive" -C "$GOMOD_DIR" cyclonedx-gomod
  chmod 755 "$GOMOD_BIN"
  printf '%s\n' "$sha" > "$GOMOD_DIR/PIN"
  local got
  got="$("$GOMOD_BIN" version 2>&1 || true)"
  [[ "$got" == *"$GOMOD_VERSION"* ]] || die "cyclonedx-gomod instalado não é $GOMOD_VERSION: $got"
}

install_npm_tool() {
  NPM_DIR="$CACHE/cyclonedx-npm-${NPM_TOOL_VERSION}"
  NPM_CLI="$NPM_DIR/node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js"
  if [[ -f "$NPM_CLI" && "$(cat "$NPM_DIR/PIN" 2>/dev/null || true)" == "$NPM_TOOL_INTEGRITY" ]]; then
    return 0
  fi
  local tarball="$dl/cyclonedx-npm-${NPM_TOOL_VERSION}.tgz"
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 -o "$tarball" "$NPM_TOOL_URL"
  python3 "$ROOT/scripts/validate-sbom.py" integrity --file "$tarball" --expected "$NPM_TOOL_INTEGRITY"
  rm -rf "$NPM_DIR"
  mkdir -p "$NPM_DIR"
  (
    cd "$NPM_DIR"
    npm install --ignore-scripts --omit=optional --no-package-lock --no-fund --no-audit "$tarball"
  )
  node -e 'const p=require(process.argv[1]); if (p.version !== process.argv[2]) process.exit(1)' \
    "$NPM_DIR/node_modules/@cyclonedx/cyclonedx-npm/package.json" "$NPM_TOOL_VERSION" \
    || die "pacote @cyclonedx/cyclonedx-npm instalado não é $NPM_TOOL_VERSION"
  printf '%s\n' "$NPM_TOOL_INTEGRITY" > "$NPM_DIR/PIN"
  local got
  got="$(node "$NPM_CLI" --version)"
  [[ "$got" == "$NPM_TOOL_VERSION" || "$got" == "v$NPM_TOOL_VERSION" ]] || die "CLI cyclonedx-npm inesperada: $got"
}

stamp() {
  local file="$1" ecosystem="$2" tool_name="$3" tool_version="$4" scope="$5"
  python3 "$ROOT/scripts/validate-sbom.py" apply \
    --file "$file" \
    --ecosystem "$ecosystem" \
    --commit "$commit" \
    --run "$run_id" \
    --toolchain-go "$go_tc" \
    --toolchain-node "$node_tc" \
    --toolchain-npm "$npm_tc" \
    --tool-name "$tool_name" \
    --tool-version "$tool_version" \
    --scope "$scope"
  python3 "$ROOT/scripts/validate-sbom.py" check \
    --file "$file" \
    --ecosystem "$ecosystem" \
    --expect-commit "$commit"
}

install_gomod
install_npm_tool

"$GOMOD_BIN" mod -json -test -output-version 1.6 -output "$work/go.cdx.json" "$ROOT/apps/api-go" \
  || die "cyclonedx-gomod falhou; nenhum SBOM foi publicado"
# A validação de schema do cyclonedx-npm depende de pacotes opcionais. O gate é validate-sbom.py.
# npm ls --package-lock-only exits 1 when an optional WASM peer is absent
# (@emnapi/* required by @tailwindcss/oxide-wasm32-wasi). --ignore-npm-errors
# keeps the lockfile inventory; validate-sbom.py still rejects an empty result.
npm_config_engine_strict=false node "$NPM_CLI" \
  --package-lock-only \
  --ignore-npm-errors \
  --no-validate \
  --output-format JSON \
  --spec-version 1.6 \
  --mc-type application \
  --output-file "$work/npm.cdx.json" \
  -- package.json \
  || die "cyclonedx-npm falhou; nenhum SBOM foi publicado"

[[ -s "$work/go.cdx.json" && -s "$work/npm.cdx.json" ]] || die "geração não escreveu os dois SBOMs"
stamp "$work/go.cdx.json" go cyclonedx-gomod "$GOMOD_VERSION" "$GO_SCOPE"
stamp "$work/npm.cdx.json" npm @cyclonedx/cyclonedx-npm "$NPM_TOOL_VERSION" "$NPM_SCOPE"

mkdir -p "$OUT"
mv "$work/go.cdx.json" "$OUT/go.cdx.json"
mv "$work/npm.cdx.json" "$OUT/npm.cdx.json"
echo "SBOM go: $OUT/go.cdx.json"
echo "SBOM npm: $OUT/npm.cdx.json"
echo "commit: $commit"
echo "run: $run_id"
