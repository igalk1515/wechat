#!/usr/bin/env bash
# Deploy the sketch server to the shared EC2. Run from the repo root.
#
#   SSH_KEY=/path/to/mashkanta-key.pem bash infra/deploy.sh
#
# Ships freshly-pulled origin/main only (ALLOW_DIRTY=1 / ALLOW_BRANCH=1 are
# deliberate, noisy escape hatches). Atomic release under
# ~/sketch/releases/<ts>-<sha>, `current` symlink flip, keeps last 3.
set -euo pipefail

HOST_IP="16.164.44.127"
DOMAIN="sketch.igal-web.com"
APP="sketch"
SSH_KEY="${SSH_KEY:-/c/Users/user/Desktop/peronProjects/Mashkata/mashkanta-key.pem}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ec2-user@$HOST_IP")

say() { printf '\n== %s ==\n' "$*"; }

say "pre-flight: main, clean, synced"
git fetch origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ "${ALLOW_BRANCH:-0}" != "1" ]; then
  echo "FATAL: on '$BRANCH', not main. Ship main, or ALLOW_BRANCH=1 to override." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "FATAL: working tree dirty. Commit/push first, or ALLOW_DIRTY=1 to override." >&2
  exit 1
fi
read BEHIND AHEAD < <(git rev-list --left-right --count origin/main...HEAD)
if [ "$BEHIND" != "0" ]; then
  echo "FATAL: $BEHIND commits behind origin/main - run: git pull --ff-only origin main" >&2
  exit 1
fi
if [ "$AHEAD" != "0" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "FATAL: $AHEAD commits ahead of origin/main - push them first." >&2
  exit 1
fi

SHA=$(git rev-parse --short HEAD)
REL="$(date -u +%Y%m%d%H%M%S)-$SHA"
say "ship release $REL"
echo "$REL" > server/release.txt
tar -C server -cf - --exclude node_modules --exclude '.env*' --exclude '*.pem' . | \
  "${SSH[@]}" "mkdir -p ~/$APP/releases/$REL && tar -xf - -C ~/$APP/releases/$REL"
rm -f server/release.txt

say "install deps + flip symlink + restart"
"${SSH[@]}" "
  set -e
  cd ~/$APP/releases/$REL
  npm ci --omit=dev --no-audit --no-fund
  ln -sfn ~/$APP/releases/$REL ~/$APP/current
  sudo systemctl restart $APP
  sleep 1
  systemctl is-active --quiet $APP || { echo 'FATAL: $APP.service did not start'; sudo journalctl -u $APP -n 20 --no-pager; exit 1; }
  cd ~/$APP/releases && ls -1t | tail -n +4 | xargs -r rm -rf
"

say "smoke: health must report THIS release"
BODY=$(curl -s --max-time 15 "https://$DOMAIN/")
echo "$BODY"
echo "$BODY" | grep -q "$REL" || { echo "FATAL: live health does not report $REL - old code still running?" >&2; exit 1; }

say "smoke: real websocket handshake (expect hello from server)"
node -e "
const WebSocket = require('./server/node_modules/ws');
const ws = new WebSocket('wss://$DOMAIN');
const t = setTimeout(() => { console.error('FATAL: no hello within 10s'); process.exit(1); }, 10000);
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'hello') { console.log('websocket OK, server said hello as ' + m.clientId); clearTimeout(t); ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('FATAL: ' + e.message); process.exit(1); });
"

say "co-tenant smoke (expect 2xx/3xx)"
for u in https://markav.igal-web.com https://babybet.igal-web.com https://igal-web.com https://navso.tech; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u" || echo FAIL)
  echo "$u -> $code"
done

echo
echo "deployed $REL to wss://$DOMAIN"
