#!/usr/bin/env bash
set -euo pipefail

tool="$1"
shift

# Leading dash args are tool flags; the rest are repo-relative files from
# pre-commit, rebased to the integ/ package root. This is the twin of
# typescript/scripts/precommit-run.sh: integ is its own ESLint base path and
# its own prettier root, so the two trees cannot share one runner.
args=()
for a in "$@"; do
  if [[ "$a" == -* ]]; then
    args+=("$a")
  else
    args+=("${a#integ/}")
  fi
done

cd "$(dirname "$0")/.."
exec pnpm exec "$tool" "${args[@]}"
