#!/usr/bin/env bash
# Roll the sketch server back to the previous release (symlink flip).
#   SSH_KEY=/path/to/mashkanta-key.pem bash infra/rollback.sh
set -euo pipefail

HOST_IP="16.164.44.127"
APP="sketch"
DOMAIN="sketch.igal-web.com"
SSH_KEY="${SSH_KEY:-/c/Users/user/Desktop/peronProjects/Mashkata/mashkanta-key.pem}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ec2-user@$HOST_IP")

"${SSH[@]}" "
  set -e
  cd ~/$APP/releases
  CURRENT=\$(basename \$(readlink ~/$APP/current))
  PREV=\$(ls -1t | grep -v \"^\$CURRENT\$\" | head -1)
  [ -n \"\$PREV\" ] || { echo 'FATAL: no previous release to roll back to' >&2; exit 1; }
  echo \"rolling back \$CURRENT -> \$PREV\"
  ln -sfn ~/$APP/releases/\$PREV ~/$APP/current
  sudo systemctl restart $APP
  sleep 1
  systemctl is-active --quiet $APP
"
curl -s --max-time 15 "https://$DOMAIN/"
