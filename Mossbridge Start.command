#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "Starting Mossbridge ClaudeCode service..."
echo
npm run service:restart:claudecode
echo
npm run service:status:claudecode
echo
echo "If launchd=loaded and bridge_alive=yes, Mossbridge is running."
echo "You can close this window."
echo
read -k 1 "?Press any key to close..."
