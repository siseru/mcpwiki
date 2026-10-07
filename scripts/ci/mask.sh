#!/usr/bin/env bash
# Registers environment-specific values with the GitHub Actions log masker (run first in every job).
# "::add-mask::" lines are consumed by the runner and never displayed; afterwards every occurrence of the
# value in logs is shown as ***. Sources: AWS_ACCOUNT_ID, MCPWIKI_DOMAINS (JSON), REDACT_EXTRA (comma-separated
# values or URLs; for URLs the host is masked). See scripts/ci/redact.mjs for redacting piped output.
set -euo pipefail
count=0
mask() {
  local v="$1"
  if [ "${#v}" -ge 4 ]; then echo "::add-mask::$v"; count=$((count + 1)); fi
}
mask "${AWS_ACCOUNT_ID:-}"
if [ -n "${MCPWIKI_DOMAINS:-}" ]; then
  while IFS= read -r v; do mask "$v"; done < <(jq -r '.hostedZoneId, .zoneName, (.hosts // {} | .[] | ., "auth." + .)' <<< "$MCPWIKI_DOMAINS")
fi
IFS=',' read -ra extras <<< "${REDACT_EXTRA:-}"
for v in "${extras[@]}"; do
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" == *://* ]]; then v="${v#*://}"; v="${v%%/*}"; fi
  mask "$v"
done
echo "mask: registered $count value(s)"
