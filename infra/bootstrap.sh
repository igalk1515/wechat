#!/usr/bin/env bash
# One-time bootstrap of the sketch co-tenant on the shared EC2.
# Idempotent: safe to re-run. Run from the repo root (Git Bash on Windows is fine).
#
#   SSH_KEY=/path/to/mashkanta-key.pem bash infra/bootstrap.sh
#
# Steps: recon (collision checks) -> DNS gate -> nginx vhost (auto-removed on
# nginx -t failure) -> certbot dry-run -> real cert -> systemd unit -> co-tenant
# regression. Does NOT start the app: run infra/deploy.sh afterwards.
set -euo pipefail

HOST_IP="16.164.44.127"
DOMAIN="sketch.igal-web.com"
APP="sketch"
PORT="8098"
SSH_KEY="${SSH_KEY:-/c/Users/user/Desktop/peronProjects/Mashkata/mashkanta-key.pem}"
SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ec2-user@$HOST_IP")

say() { printf '\n== %s ==\n' "$*"; }

say "recon: conf / port collisions"
if "${SSH[@]}" "test -f /etc/nginx/conf.d/$APP.conf"; then
  echo "conf.d/$APP.conf already exists on the box - continuing (idempotent re-run)"
fi
if "${SSH[@]}" "sudo ss -tlnp | grep -q ':$PORT '"; then
  if ! "${SSH[@]}" "systemctl is-active --quiet $APP"; then
    echo "FATAL: port $PORT is taken by something that is not $APP.service - pick another port" >&2
    exit 1
  fi
fi
if "${SSH[@]}" "sudo nginx -T 2>/dev/null | grep -q 'server_name $DOMAIN'" && \
   ! "${SSH[@]}" "grep -q 'server_name $DOMAIN' /etc/nginx/conf.d/$APP.conf 2>/dev/null"; then
  echo "FATAL: $DOMAIN is claimed by another conf on the box" >&2
  exit 1
fi

say "DNS gate: $DOMAIN must resolve"
RESOLVED=$("${SSH[@]}" "getent hosts $DOMAIN | awk '{print \$1}' | head -1" || true)
if [ -z "$RESOLVED" ]; then
  echo "FATAL: $DOMAIN does not resolve yet. Add an A record -> $HOST_IP and retry." >&2
  exit 1
fi
echo "resolves to: $RESOLVED"
[ "$RESOLVED" != "$HOST_IP" ] && echo "note: not the raw EIP (Cloudflare proxy?) - continuing"

say "install nginx vhost (removed automatically if nginx -t fails)"
"${SSH[@]}" "cat > /tmp/$APP.conf" < infra/sketch.conf
"${SSH[@]}" "
  set -e
  sudo mv /tmp/$APP.conf /etc/nginx/conf.d/$APP.conf
  if ! sudo nginx -t; then
    sudo rm -f /etc/nginx/conf.d/$APP.conf
    echo 'FATAL: nginx -t failed - conf removed, nothing reloaded' >&2
    exit 1
  fi
  sudo systemctl reload nginx
"

say "certbot (skipped if cert already exists)"
if "${SSH[@]}" "sudo test -d /etc/letsencrypt/live/$DOMAIN"; then
  echo "cert already present - skipping issuance"
else
  "${SSH[@]}" "sudo certbot certonly --nginx --dry-run -d $DOMAIN"
  "${SSH[@]}" "sudo certbot --nginx -n --agree-tos -m igalk1515@gmail.com --redirect -d $DOMAIN"
  "${SSH[@]}" "sudo nginx -t && sudo systemctl reload nginx"
fi

say "install systemd unit (enabled, started by deploy.sh)"
"${SSH[@]}" "cat > /tmp/$APP.service" < infra/sketch.service
"${SSH[@]}" "
  set -e
  sudo mv /tmp/$APP.service /etc/systemd/system/$APP.service
  sudo systemctl daemon-reload
  sudo systemctl enable $APP >/dev/null 2>&1 || true
  mkdir -p ~/$APP/releases
"

say "co-tenant regression (expect 2xx/3xx everywhere)"
for u in https://markav.igal-web.com https://babybet.igal-web.com https://igal-web.com https://navso.tech https://www.itsthespotlight.com https://unemployedking.com; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$u" || echo FAIL)
  echo "$u -> $code"
done

echo
echo "bootstrap done. Now run: bash infra/deploy.sh"
