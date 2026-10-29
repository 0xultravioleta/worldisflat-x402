#!/usr/bin/env bash
# Pre-CI: the same steps as .github/workflows/ci.yml, on Node 22, plus a secret scan of the branch's diff.
#   bash scripts/ci/preflight.sh [base]      (base defaults to $PREFLIGHT_BASE, then origin/main)
set -euo pipefail
base="${1:-${PREFLIGHT_BASE:-origin/main}}"
cd "$(dirname "$0")/../.."

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [ "$major" != "22" ] && [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi
echo "node $(node --version), base $base"

rows=()
run() {
  local name="$1"; shift
  local t0=$SECONDS
  if "$@"; then rows+=("| $name | \`$*\` | pass | $((SECONDS - t0)) s |")
  else rows+=("| $name | \`$*\` | FAIL | $((SECONDS - t0)) s |"); printf '%s\n' "${rows[@]}"; exit 1; fi
}

run install npm ci --no-audit --no-fund
run typecheck npm run typecheck
# unit tests with the network closed: they must not need an RPC or the facilitator
run test env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost npm test
if command -v gitleaks >/dev/null 2>&1; then
  run secrets gitleaks detect --redact --no-banner --log-opts="$base...HEAD"
else
  echo "gitleaks not installed: secret scan skipped" >&2
fi

echo
echo "| step | command | result | time |"
echo "|---|---|---|---|"
printf '%s\n' "${rows[@]}"
