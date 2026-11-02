#!/usr/bin/env bash
set -Eeuo pipefail

# Prepare a fresh Ubuntu 24.04 ARM64 OCI VM for future Forge worker deployment.
# This script does NOT deploy Forge, register a GitHub runner, open app ports,
# configure credentials, apply database migrations, or start a worker.

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This bootstrap is for Linux only." >&2
  exit 1
fi

if ! grep -qiE 'ubuntu' /etc/os-release; then
  echo "Use Ubuntu 24.04 LTS for this bootstrap." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "x86_64" ]]; then
  echo "Unsupported architecture: $ARCH" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash ops/free-cloud/oci-bootstrap.sh" >&2
  exit 1
fi

SSH_PORT="${SSH_PORT:-22}"
if ! [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
  echo "SSH_PORT must be a valid TCP port." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq unzip xz-utils build-essential \
  python3 python3-venv python3-pip gnupg ufw fail2ban unattended-upgrades

# Install Node.js 22 LTS for app tooling; use the official NodeSource repository.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
chmod 0644 /etc/apt/keyrings/nodesource.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y nodejs

# Install Bun system-wide for the dedicated forge user.
if ! id forge >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash forge
fi
install -d -o forge -g forge -m 0750 /opt/forge
su - forge -c 'curl -fsSL https://bun.sh/install | bash'

# Docker Engine from Docker's official apt repository (useful for future isolated jobs).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Do not add the forge account to the docker group: Docker access is effectively root.
# Future worker isolation must use a dedicated, restricted execution boundary.
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp"
ufw --force enable
systemctl enable --now fail2ban
systemctl enable --now unattended-upgrades

cat <<'SUMMARY'

Host preparation finished.
- Dedicated unprivileged 'forge' user created.
- Bun, Node.js 22, Docker Engine and basic security updates installed.
- Firewall allows SSH only; no app or worker ports were opened.
- No repository was cloned and no service was started.
- No GitHub/Supabase/Vercel/model secrets were requested or stored.

Next: review the worker execution isolation design before running arbitrary repository code.
SUMMARY

node --version
docker --version
su - forge -c '$HOME/.bun/bin/bun --version'
