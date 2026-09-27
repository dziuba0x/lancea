#!/usr/bin/env bash
# One-time setup of a fresh Debian 12 machine (e.g. a Google Cloud e2-micro) for Lancea's testnet demo.
# Run it as a user with sudo:
#   curl -fsSL https://raw.githubusercontent.com/dziuba0x/lancea/main/deploy/bootstrap.sh | bash
# It installs Node 22, puts Lancea in /opt/lancea, makes the guard's and the agent's keys HERE (they never
# leave this machine), installs the two services, and prints the keys' public half for provisioning.
set -euo pipefail

sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates
if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

id lancea >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/lancea --shell /usr/sbin/nologin lancea
if [ -d /opt/lancea/.git ]; then sudo git -C /opt/lancea pull --ff-only; else sudo git clone https://github.com/dziuba0x/lancea.git /opt/lancea; fi
sudo chown -R lancea:lancea /opt/lancea
sudo -u lancea bash -c 'cd /opt/lancea && npm ci --no-audit --no-fund'

sudo install -d -o lancea -g lancea -m 700 /etc/lancea /etc/lancea/keys
sudo install -d -o lancea -g lancea -m 750 /var/lib/lancea

if sudo test -f /etc/lancea/keys/guard.json; then
  echo "Keys already exist in /etc/lancea/keys: kept."
else
  sudo -u lancea bash -c 'cd /opt/lancea && LANCEA_KEYS=/etc/lancea/keys node --import tsx scripts/keys-init.ts' | tee "$HOME/keys-public.json"
  echo "The public half is in ~/keys-public.json (addresses only, nothing secret)."
fi

sudo cp /opt/lancea/deploy/lancea-guard.service /opt/lancea/deploy/lancea-autopilot.service /etc/systemd/system/
sudo systemctl daemon-reload
cat <<'NEXT'

Next:
  1. On the principal's machine: npx tsx scripts/provision.ts --keys keys-public.json   (it writes lancea.config.json)
  2. Here: put that file at /etc/lancea/config.json (it holds no key), then
       sudo chown lancea:lancea /etc/lancea/config.json
       sudo systemctl enable --now lancea-guard lancea-autopilot
       journalctl -u lancea-autopilot -f
NEXT
