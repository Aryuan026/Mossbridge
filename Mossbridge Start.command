#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "Starting Mossbridge service..."
echo
RUNTIME="${MOSSBRIDGE_RUNTIME:-codex}"
if [[ "$RUNTIME" != "codex" && "$RUNTIME" != "claudecode" ]]; then
  echo "Unsupported MOSSBRIDGE_RUNTIME=$RUNTIME"
  exit 1
fi

echo "Runtime: $RUNTIME"
echo
npm run "service:restart:${RUNTIME}"
echo
npm run "service:status:${RUNTIME}"
echo
echo "If launchd=loaded and bridge_alive=yes, Mossbridge is running."
echo "You can close this window."
echo
read -k 1 "?Press any key to close..."
