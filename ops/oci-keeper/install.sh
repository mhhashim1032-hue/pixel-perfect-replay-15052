#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_DIR="/opt/forge-keeper"
ENV_FILE="/etc/forge-keeper.env"
UNIT_FILE="/etc/systemd/system/forge-keeper.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with: sudo bash ops/oci-keeper/install.sh" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install Node.js before running this script." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

id forge-keeper >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin forge-keeper
install -d -o root -g forge-keeper -m 0750 "$SERVICE_DIR"
install -o root -g forge-keeper -m 0640 "$ROOT/ops/oci-keeper/server.mjs" "$SERVICE_DIR/server.mjs"
install -o root -g root -m 0644 "$ROOT/ops/oci-keeper/forge-keeper.service" "$UNIT_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
  SECRET="$(openssl rand -hex 32)"
  install -o root -g forge-keeper -m 0640 /dev/null "$ENV_FILE"
  {
    printf 'FORGE_KEEPER_SECRET=%s\n' "$SECRET"
    printf 'FORGE_KEEPER_ALLOWED_ORIGINS=https://YOUR-FORGE-APP-DOMAIN.example\n'
    printf 'FORGE_KEEPER_PORT=8787\n'
  } > "$ENV_FILE"
  chown root:forge-keeper "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
fi

systemctl daemon-reload
systemctl enable --now forge-keeper.service

echo "Forge keeper installed. It listens only on 127.0.0.1:8787."
echo "Edit $ENV_FILE and replace FORGE_KEEPER_ALLOWED_ORIGINS with your exact HTTPS Forge app origin."
echo "Copy FORGE_KEEPER_SECRET from $ENV_FILE into the Forge app's server-only environment as FORGE_KEEPER_SECRET."
echo "Do not expose port 8787 publicly; use a Cloudflare Tunnel to 127.0.0.1:8787."
echo "Health check: curl http://127.0.0.1:8787/health"
