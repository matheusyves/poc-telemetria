#!/usr/bin/env bash
set -u -o pipefail

run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
export TELEMETRY_DIR="${TELEMETRY_DIR:-artifacts/telemetry-local-${run_stamp}}"
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$PWD/.pycache}"
mkdir -p "$PYTHONPYCACHEPREFIX"

python3 scripts/telemetry.py start
result=0

python3 scripts/telemetry.py run --name validate -- python3 -m py_compile scripts/telemetry.py || result=$?
python3 scripts/telemetry.py run --name tests -- python3 -m unittest discover -s tests -v || result=$?

if [[ "${SIMULATE_FAILURE:-false}" == "true" ]]; then
  python3 scripts/telemetry.py run --name synthetic_failure -- python3 -c 'import sys; print("falha sintética para validar observabilidade"); sys.exit(17)' || result=$?
fi

if [[ "$result" -eq 0 ]]; then
  python3 scripts/telemetry.py finish --status success
else
  python3 scripts/telemetry.py finish --status failure
fi

echo "Evidência criada em: ${TELEMETRY_DIR}"
exit "$result"
