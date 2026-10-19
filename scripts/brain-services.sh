#!/bin/bash
# Manage Second Brain background workers as launchd user agents (the API dev server is NOT managed here).
# Usage: scripts/brain-services.sh install|start|stop|restart|status|uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
NODE_BIN="$(dirname "$(command -v node || echo /opt/homebrew/opt/node@24/bin/node)")"
DOMAIN="gui/$(id -u)"
# label  script
SERVICES=("org.secondbrain.worker:worker.ts" "org.secondbrain.evaluate:evaluation-worker.ts" "org.secondbrain.research:research-worker.ts")

plist() { # label script
  local label=$1 script=$2 name=${1##*.}
  cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ROOT/node_modules/.bin/tsx</string>
    <string>apps/api/src/$script</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/logs/$name.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$name.log</string>
</dict>
</plist>
P
}

install() {
  mkdir -p "$ROOT/logs" "$AGENTS"
  for s in "${SERVICES[@]}"; do plist "${s%%:*}" "${s##*:}" > "$AGENTS/${s%%:*}.plist"; plutil -lint -s "$AGENTS/${s%%:*}.plist"; done
  echo "Installed plists in $AGENTS"
}
start() {
  for s in "${SERVICES[@]}"; do l=${s%%:*}
    [ -f "$AGENTS/$l.plist" ] || plist "$l" "${s##*:}" > "$AGENTS/$l.plist"
    if launchctl print "$DOMAIN/$l" >/dev/null 2>&1; then echo "$l already loaded"; else launchctl bootstrap "$DOMAIN" "$AGENTS/$l.plist" && echo "started $l"; fi
  done
}
stop() { # bootout sends SIGTERM; workers finish their current job then exit
  for s in "${SERVICES[@]}"; do l=${s%%:*}
    if launchctl print "$DOMAIN/$l" >/dev/null 2>&1; then launchctl bootout "$DOMAIN/$l" && echo "stopped $l"; else echo "$l not loaded"; fi
  done
}
status() {
  for s in "${SERVICES[@]}"; do l=${s%%:*}
    if launchctl print "$DOMAIN/$l" >/dev/null 2>&1; then
      pid=$(launchctl print "$DOMAIN/$l" | awk '/^\tpid =/{print $3}'); echo "$l: loaded, pid=${pid:-none}"
    else echo "$l: not loaded"; fi
  done
}
case "${1:-status}" in
  install) install ;; start) start ;; stop) stop ;; restart) stop; sleep 2; start ;; status) status ;;
  uninstall) stop; for s in "${SERVICES[@]}"; do rm -f "$AGENTS/${s%%:*}.plist"; done; echo "plists removed" ;;
  *) echo "Usage: $0 install|start|stop|restart|status|uninstall"; exit 2 ;;
esac
