#!/bin/bash
set -euo pipefail

echo "==> Remote Browser MCP — Deploy"
echo ""

# Install Docker if not present
if ! command -v docker &>/dev/null; then
    echo "==> Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
    echo "==> Docker installed."
fi

# Install Docker Compose plugin if not present
if ! docker compose version &>/dev/null; then
    echo "==> Installing Docker Compose plugin..."
    apt-get update && apt-get install -y docker-compose-plugin
    echo "==> Docker Compose installed."
fi

# Generate SSH keys for tunnel access
mkdir -p data/ssh
if [ ! -f data/ssh/tunnel_key ]; then
    echo "==> Generating SSH tunnel keys..."
    ssh-keygen -t ed25519 -f data/ssh/tunnel_key -N ""
    cat data/ssh/tunnel_key.pub > data/ssh/authorized_keys
    chmod 600 data/ssh/authorized_keys
    echo "==> SSH keys generated."
else
    echo "==> SSH keys already exist, skipping."
fi

# Build and start
echo "==> Building containers..."
docker compose build

echo "==> Starting services..."
docker compose up -d

echo ""
echo "========================================="
echo "  Remote Browser MCP — Deployed"
echo "========================================="
echo ""
echo "  MCP Server:  https://rembro.digitalno.de"
echo "  VNC Viewer:  https://vnc.rembro.digitalno.de"
echo "  Tunnel:      ssh -R 3000:localhost:3000 -p 2222 tunnel@rembro.digitalno.de -i data/ssh/tunnel_key"
echo ""
docker compose ps
