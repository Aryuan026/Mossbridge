#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "Mossbridge service status"
echo
RUNTIME="${MOSSBRIDGE_RUNTIME:-codex}"
if [[ "$RUNTIME" != "codex" && "$RUNTIME" != "claudecode" ]]; then
  echo "Unsupported MOSSBRIDGE_RUNTIME=$RUNTIME"
  exit 1
fi

echo "Runtime: $RUNTIME"
echo
npm run "service:status:${RUNTIME}"
echo
if [[ "$RUNTIME" == "claudecode" ]]; then
  npm run shared:status:claudecode
else
  npm run shared:status
fi
echo
echo "Healthy means: launchd=loaded, bridge_alive=yes, and a shared_mossbridge_pid is present."
echo "You can close this window."
echo
read -k 1 "?Press any key to close..."
