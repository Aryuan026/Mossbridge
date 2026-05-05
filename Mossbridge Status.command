#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")"

echo "Mossbridge service status"
echo
npm run service:status:claudecode
echo
npm run shared:status:claudecode
echo
echo "Healthy means: launchd=loaded, bridge_alive=yes, and a shared_asheriebridge_pid is present."
echo "You can close this window."
echo
read -k 1 "?Press any key to close..."
