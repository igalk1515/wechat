# Deploy: Sketch Together server (co-tenant "sketch" on the shared EC2)

| Fact | Value |
|---|---|
| Domain | `sketch.igal-web.com` (extension connects to `wss://sketch.igal-web.com`) |
| Box | 16.164.44.127 (shared, il-central-1) |
| Port | 8098, bound 127.0.0.1 only, proxied by nginx (`/etc/nginx/conf.d/sketch.conf`) |
| Unit | `sketch.service` (systemd, `User=ec2-user`) |
| Path | `~/sketch/releases/<ts>-<sha>/` with `~/sketch/current` symlink (last 3 kept) |
| SSH key | `SSH_KEY` env; defaults to the Mashkata key path |

## One-command deploy (from repo root, Git Bash)

```bash
bash infra/deploy.sh
```

Ships freshly-pulled `origin/main` only; refuses branches, dirty or unsynced trees
(`ALLOW_BRANCH=1` / `ALLOW_DIRTY=1` to override, on purpose and noisily).
Smoke-verifies: health endpoint reports the new release id, WebSocket upgrade
returns 101, co-tenants still answer.

## First-time bootstrap (already done once; idempotent)

1. DNS: A record `sketch.igal-web.com -> 16.164.44.127` must resolve.
2. `bash infra/bootstrap.sh` — installs nginx vhost + Let's Encrypt cert +
   systemd unit, then regression-checks every co-tenant.
3. `bash infra/deploy.sh`

## Rollback

```bash
bash infra/rollback.sh   # flips `current` to the previous release, restarts
```

## Health check

`https://sketch.igal-web.com/` returns `Sketch Together server is running (<release>)`.
