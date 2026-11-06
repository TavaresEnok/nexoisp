#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Delegate to the existing development CLI so its local Compose options apply.
exec ./nexo compose run --rm -e "NEXO_RESTORE_DATABASE=$1" migrate verify-restore
