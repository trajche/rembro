# Remote Browser MCP: Infrastructure Deployment Specification

## Overview

This document provides concrete, production-ready deployment specifications for the Remote Browser MCP service. It covers single-node MVP deployment and scaling strategies for multi-node setups.

---

## 1. Hetzner Server Setup

### 1.1 Server Selection

#### **Production (MVP & Beyond)**
```
Type: Dedicated Root Server AX41-NVMe
CPU: 6-core AMD Ryzen 5000
RAM: 64GB DDR4
Storage: 2x 512GB NVMe (RAID 1 recommended)
Network: 1 Gbps, Unlimited bandwidth
OS: Ubuntu 24.04 LTS
Cost: ~€40-45/month

Capacity: 25-40 concurrent user sessions
```

#### **Development**
```
Type: Cloud VM CPX22
vCPU: 4
RAM: 16GB
Storage: 160GB SSD
Network: 20 Gbps shared
Cost: ~€10/month

Capacity: 5-10 concurrent sessions (testing)
```

### 1.2 Initial Provisioning Script

**Save as `provision-hetzner.sh`:**

```bash
#!/bin/bash
set -euo pipefail

# Script: Initial Hetzner AX41-NVMe Server Setup
# Run as root after fresh Ubuntu 24.04 install
# Usage: curl -sSL https://your-repo/provision-hetzner.sh | bash

HOSTNAME="remotebrowser-1"
TIMEZONE="UTC"
SSH_KEY="ssh-rsa AAAA..."  # Your SSH public key

# Update system
apt-get update
apt-get upgrade -y
apt-get install -y \
    curl wget git \
    build-essential \
    linux-headers-generic \
    net-tools \
    htop nvtop \
    apparmor apparmor-utils \
    docker.io docker-compose-plugin \
    wireguard wireguard-tools \
    ca-certificates \
    gnupg lsb-release

# Configure hostname and timezone
hostnamectl set-hostname "${HOSTNAME}"
timedatectl set-timezone "${TIMEZONE}"

# Add Docker key and enable Docker socket
usermod -aG docker ubuntu
systemctl enable docker
systemctl start docker

# Kernel tuning for VNC/WebRTC performance
cat >> /etc/sysctl.conf <<EOF
# Network buffer optimization for streaming
net.core.rmem_max=134217728
net.core.wmem_max=134217728
net.core.rmem_default=134217728
net.core.wmem_default=134217728
net.ipv4.tcp_rmem=4096 87380 67108864
net.ipv4.tcp_wmem=4096 65536 67108864

# Connection tracking for WireGuard
net.netfilter.nf_conntrack_max=262144
net.netfilter.nf_conntrack_tcp_timeout_established=600

# Increase open file descriptors
fs.file-max=2097152
EOF
sysctl -p

# Configure ulimits for container density
cat >> /etc/security/limits.conf <<EOF
* soft nofile 65536
* hard nofile 65536
* soft nproc 32768
* hard nproc 32768
EOF

# Enable IP forwarding and WireGuard
cat >> /etc/sysctl.conf <<EOF
net.ipv4.ip_forward=1
net.ipv6.conf.all.forwarding=1
EOF
sysctl -p

# Create necessary directories
mkdir -p /opt/remotebrowser/{configs,data,logs,scripts}
mkdir -p /opt/remotebrowser/containers/{browser,mcp,proxy}

# WireGuard setup
mkdir -p /etc/wireguard
umask 077
wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key

# Create WireGuard interface config (server side)
cat > /etc/wireguard/wg0.conf <<'EOF'
[Interface]
Address = 10.0.0.1/24
SaveMconfig = false
ListenPort = 51820
PrivateKey = $(cat /etc/wireguard/server_private.key)

# PostUp/PostDown: will be configured dynamically per user session
EOF

# Enable WireGuard at boot
systemctl enable wg-quick@wg0
# Don't start yet—configure after deployment

# Setup UFW firewall (if desired)
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP (Caddy)
ufw allow 443/tcp    # HTTPS (Caddy)
ufw allow 51820/udp  # WireGuard
# Neko ports (per-container, range 5000-6000) added dynamically

# Create SSH key for ubuntu user if provided
if [ -n "${SSH_KEY}" ]; then
    mkdir -p /home/ubuntu/.ssh
    echo "${SSH_KEY}" > /home/ubuntu/.ssh/authorized_keys
    chmod 600 /home/ubuntu/.ssh/authorized_keys
    chown -R ubuntu:ubuntu /home/ubuntu/.ssh
fi

# Create systemd service for session orchestrator (placeholder)
mkdir -p /etc/systemd/system
# Will be populated during deployment

# Install Prometheus node exporter (for monitoring)
curl -sSL https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz | \
    tar -xz -C /opt/remotebrowser/scripts/
ln -s /opt/remotebrowser/scripts/node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/node_exporter

cat > /etc/systemd/system/node_exporter.service <<EOF
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/local/bin/node_exporter
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable node_exporter
systemctl start node_exporter

# Create docker bridge network for containers
docker network create remotebrowser \
    --driver bridge \
    --subnet=172.20.0.0/16 \
    --ip-range=172.20.0.0/24 \
    || true

echo "✓ Hetzner AX41 provisioning complete!"
echo "  Hostname: $(hostname)"
echo "  Docker: $(docker version --format '{{.Server.Version}}')"
echo "  WireGuard private key: /etc/wireguard/server_private.key"
echo "  Public key: /etc/wireguard/server_public.key"
echo ""
echo "Next steps:"
echo "  1. Clone deployment repo: git clone https://github.com/your-org/remotebrowser-deploy /opt/remotebrowser/deploy"
echo "  2. Configure .env in deployment directory"
echo "  3. Run: cd /opt/remotebrowser/deploy && docker compose up -d"
```

**Execution:**

```bash
# On local machine
scp provision-hetzner.sh root@<server-ip>:/root/
ssh root@<server-ip> bash /root/provision-hetzner.sh

# Or inline
ssh root@<server-ip> bash < provision-hetzner.sh
```

### 1.3 Storage & Backup

```bash
# Check RAID status (if configured)
cat /proc/mdstat

# Backup configuration (daily, to cloud storage)
# Install restic for incremental backups
curl -sSL https://github.com/restic/restic/releases/download/v0.16.2/restic_0.16.2_linux_amd64.bz2 | \
    bunzip2 | tee /usr/local/bin/restic > /dev/null
chmod +x /usr/local/bin/restic

# Backup script (cron daily)
cat > /opt/remotebrowser/scripts/backup.sh <<'EOF'
#!/bin/bash
RESTIC_REPO="s3:s3.amazonaws.com/your-bucket/remotebrowser"
RESTIC_PASSWORD="your-password"
restic -r ${RESTIC_REPO} backup /opt/remotebrowser/configs /opt/remotebrowser/data
restic -r ${RESTIC_REPO} forget --keep-daily 7 --keep-weekly 4 --keep-monthly 12
EOF
chmod +x /opt/remotebrowser/scripts/backup.sh

# Cron job
echo "0 2 * * * /opt/remotebrowser/scripts/backup.sh >> /opt/remotebrowser/logs/backup.log 2>&1" | crontab -
```

---

## 2. Docker Compose Stack (MVP)

### 2.1 docker-compose.yml

Save as `/opt/remotebrowser/deploy/docker-compose.yml`:

```yaml
version: '3.9'

services:
  # ============================================================================
  # MCP Server (Main Control Plane)
  # ============================================================================
  mcp-server:
    build:
      context: ./services/mcp
      dockerfile: Dockerfile
    container_name: remotebrowser-mcp
    hostname: mcp-server
    networks:
      - remotebrowser
    ports:
      - "8000:8000"  # MCP API
      - "8001:8001"  # Health/metrics
    environment:
      - LOG_LEVEL=info
      - REDIS_URL=redis://redis:6379/0
      - DOCKER_HOST=unix:///var/run/docker.sock
      - SESSION_TIMEOUT=3600  # 1 hour
      - WIREGUARD_ENABLED=true
      - NETBIRD_API_URL=${NETBIRD_API_URL:-http://netbird-mgmt:8080}
      - NEKO_PORT=5000
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./configs:/app/configs:ro
      - ./data/sessions:/app/sessions
      - ./logs:/app/logs
    depends_on:
      - redis
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ============================================================================
  # Redis (Session State & Caching)
  # ============================================================================
  redis:
    image: redis:7-alpine
    container_name: remotebrowser-redis
    hostname: redis
    networks:
      - remotebrowser
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy allkeys-lru
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  # ============================================================================
  # Reverse Proxy (Caddy) - TLS Termination, Routing
  # ============================================================================
  caddy:
    image: caddy:2-alpine
    container_name: remotebrowser-caddy
    hostname: caddy
    networks:
      - remotebrowser
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"  # QUIC
    volumes:
      - ./configs/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    environment:
      - CADDY_ADMIN=0.0.0.0:2019
    restart: unless-stopped
    depends_on:
      - mcp-server

  # ============================================================================
  # NetBird Management (Optional: for WireGuard coordination)
  # ============================================================================
  netbird-mgmt:
    image: netbirdio/netbird:latest
    container_name: remotebrowser-netbird
    hostname: netbird-mgmt
    networks:
      - remotebrowser
    ports:
      - "8080:8080"  # API
      - "51820:51820/udp"  # WireGuard
    volumes:
      - netbird-data:/root/.netbird
    environment:
      - NETBIRD_MGMT_API_AUDIENCE=${DOMAIN:-localhost}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  # ============================================================================
  # Prometheus (Metrics Collection)
  # ============================================================================
  prometheus:
    image: prom/prometheus:latest
    container_name: remotebrowser-prometheus
    hostname: prometheus
    networks:
      - remotebrowser
    ports:
      - "9090:9090"
    volumes:
      - ./configs/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=30d'
    restart: unless-stopped

  # ============================================================================
  # Grafana (Visualization)
  # ============================================================================
  grafana:
    image: grafana/grafana:latest
    container_name: remotebrowser-grafana
    hostname: grafana
    networks:
      - remotebrowser
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
      - GF_SECURITY_ADMIN_USER=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
      - ./configs/grafana/provisioning:/etc/grafana/provisioning:ro
    depends_on:
      - prometheus
    restart: unless-stopped

networks:
  remotebrowser:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16

volumes:
  redis-data:
  caddy-data:
  caddy-config:
  netbird-data:
  prometheus-data:
  grafana-data:
```

### 2.2 .env File

Create `/opt/remotebrowser/deploy/.env`:

```env
# Domain & TLS
DOMAIN=remotebrowser.example.com
ACME_EMAIL=admin@example.com
TLS_PROVIDER=letsencrypt  # or letsencrypt_staging for testing

# Server Settings
SERVER_REGION=eu-central  # Hetzner region
ENVIRONMENT=production

# Session Settings
SESSION_TIMEOUT_SECONDS=3600
MAX_CONCURRENT_INSTANCES=40
INSTANCE_MEMORY_MB=450
INSTANCE_CPU_SHARES=512

# Redis
REDIS_URL=redis://redis:6379/0
REDIS_PASSWORD=

# Monitoring
GRAFANA_PASSWORD=secure-password-here
PROMETHEUS_SCRAPE_INTERVAL=15s

# WireGuard / NetBird
WIREGUARD_ENABLED=true
NETBIRD_ENABLED=true
NETBIRD_API_URL=http://netbird-mgmt:8080
NETBIRD_MGMT_TOKEN=your-mgmt-token

# Docker Registry (for custom images)
DOCKER_REGISTRY=docker.io
DOCKER_REGISTRY_USER=
DOCKER_REGISTRY_PASS=

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
```

---

## 3. Networking & Routing

### 3.1 Caddyfile Configuration

Save as `/opt/remotebrowser/deploy/configs/Caddyfile`:

```caddyfile
# TLS Settings
{
    acme_ca https://acme-v02.api.letsencrypt.org/directory
    email {$ACME_EMAIL}
}

# Main API endpoint
{$DOMAIN} {
    # Reverse proxy to MCP server
    reverse_proxy mcp-server:8000 {
        # WebSocket support
        header_up Connection "upgrade"
        header_up Upgrade "websocket"
        header_up X-Forwarded-For {http.request.remote}
        header_up X-Forwarded-Proto "https"
    }

    # Metrics endpoint (admin access only)
    @admin path /metrics
    respond @admin 403  # Restrict to internal only
}

# Per-session Neko endpoints (dynamically created)
*.neko.{$DOMAIN} {
    reverse_proxy mcp-server:8000 {
        header_up X-Forwarded-For {http.request.remote}
        header_up X-Forwarded-Proto "https"
    }
}

# Grafana dashboard
grafana.{$DOMAIN} {
    reverse_proxy grafana:3000 {
        header_up X-Forwarded-For {http.request.remote}
        header_up X-Forwarded-Proto "https"
    }
}

# Internal admin panel (restricted to VPN)
admin.{$DOMAIN} {
    reverse_proxy mcp-server:8001 {
        # Only allow from WireGuard tunnel
        @vpn_only {
            remote_ip 10.0.0.0/24
        }
        respond @vpn_only 403
    }
}
```

### 3.2 Docker Bridge Network

```bash
# Create isolated bridge network for containers
docker network create remotebrowser \
    --driver bridge \
    --subnet=172.20.0.0/16 \
    --ip-range=172.20.0.0/24 \
    --opt "com.docker.network.bridge.name=br-remotebrowser" \
    --opt "com.docker.network.driver.mtu=1500"

# Verify
docker network inspect remotebrowser
```

### 3.3 DNS Setup

For your domain registrar, add:

```dns
A record: remotebrowser.example.com → <server-public-ip>
A record: *.neko.remotebrowser.example.com → <server-public-ip>
A record: grafana.remotebrowser.example.com → <server-public-ip>
A record: admin.remotebrowser.example.com → <server-public-ip>
```

Or use CNAME if behind Hetzner load balancer:
```dns
CNAME: remotebrowser.example.com → hetzner-lb.example.com
```

---

## 4. Session Orchestrator Service

### 4.1 Python Session Manager

Create `/opt/remotebrowser/services/mcp/session_manager.py`:

```python
#!/usr/bin/env python3
"""
Session Orchestrator: Manages browser container lifecycle
- Creates containers on demand
- Tracks session state in Redis
- Cleans up expired sessions
- Health monitoring
"""

import os
import json
import uuid
import asyncio
import logging
import docker
import redis
from datetime import datetime, timedelta
from typing import Optional, Dict
import hashlib

logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO'))
logger = logging.getLogger(__name__)

class SessionManager:
    def __init__(self):
        self.docker_client = docker.from_env()
        self.redis_client = redis.Redis(
            host=os.getenv('REDIS_HOST', 'redis'),
            port=int(os.getenv('REDIS_PORT', 6379)),
            db=0,
            decode_responses=True
        )
        self.neko_port_base = int(os.getenv('NEKO_PORT_BASE', 5000))
        self.wireguard_enabled = os.getenv('WIREGUARD_ENABLED', 'true').lower() == 'true'
        self.session_timeout = int(os.getenv('SESSION_TIMEOUT_SECONDS', 3600))

    def create_session(self, user_id: str, config: Dict) -> Dict:
        """
        Create a new browser session for a user
        
        Returns:
            {
                'session_id': 'uuid',
                'neko_url': 'https://...',
                'container_id': '...',
                'created_at': '...',
                'expires_at': '...'
            }
        """
        session_id = str(uuid.uuid4())
        container_name = f"browser-{user_id}-{session_id[:8]}"
        
        try:
            # Allocate port for Neko
            neko_port = self._allocate_port()
            
            # Create WireGuard config if enabled
            wg_config = None
            if self.wireguard_enabled:
                wg_config = self._generate_wireguard_config(user_id, session_id)
            
            # Start container
            container = self.docker_client.containers.run(
                image=os.getenv('BROWSER_IMAGE', 'remotebrowser/chrome-neko:latest'),
                name=container_name,
                detach=True,
                remove=False,
                network='remotebrowser',
                environment={
                    'DISPLAY': ':99',
                    'NEKO_PORT': str(neko_port),
                    'SESSION_ID': session_id,
                    'USER_ID': user_id,
                    'TIMEZONE': 'UTC',
                    **(wg_config or {})
                },
                ports={
                    f'{neko_port}/tcp': neko_port,
                },
                volumes={
                    '/tmp/.X11-unix': {'bind': '/tmp/.X11-unix', 'mode': 'ro'},
                },
                mem_limit=f"{os.getenv('INSTANCE_MEMORY_MB', 450)}m",
                cpu_shares=int(os.getenv('INSTANCE_CPU_SHARES', 512)),
                cap_add=['SYS_ADMIN', 'SYS_PTRACE'],  # For debugging, restrict if needed
                security_opt=['seccomp=unconfined'],  # Chrome needs this
                restart_policy={'Name': 'no'},
                labels={
                    'remotebrowser.session_id': session_id,
                    'remotebrowser.user_id': user_id,
                    'remotebrowser.created_at': datetime.utcnow().isoformat(),
                }
            )
            
            # Store session metadata in Redis
            expires_at = datetime.utcnow() + timedelta(seconds=self.session_timeout)
            session_data = {
                'session_id': session_id,
                'user_id': user_id,
                'container_id': container.id,
                'container_name': container_name,
                'neko_port': neko_port,
                'neko_url': f"https://{session_id}.neko.{os.getenv('DOMAIN', 'localhost')}",
                'created_at': datetime.utcnow().isoformat(),
                'expires_at': expires_at.isoformat(),
                'status': 'starting',
                'wg_config': wg_config,
            }
            
            self.redis_client.setex(
                f"session:{session_id}",
                self.session_timeout,
                json.dumps(session_data)
            )
            
            # Track user's active sessions
            self.redis_client.sadd(f"user_sessions:{user_id}", session_id)
            
            logger.info(f"Session created: {session_id} for user {user_id}")
            return session_data
            
        except Exception as e:
            logger.error(f"Failed to create session: {e}")
            raise

    def destroy_session(self, session_id: str) -> bool:
        """Stop and remove a browser container"""
        try:
            session_data = self.redis_client.get(f"session:{session_id}")
            if not session_data:
                logger.warning(f"Session not found: {session_id}")
                return False
            
            session = json.loads(session_data)
            container_id = session['container_id']
            
            # Stop container
            try:
                container = self.docker_client.containers.get(container_id)
                container.stop(timeout=10)
                container.remove()
                logger.info(f"Container stopped: {container_id}")
            except docker.errors.NotFound:
                logger.warning(f"Container not found: {container_id}")
            
            # Clean up Redis
            user_id = session['user_id']
            self.redis_client.srem(f"user_sessions:{user_id}", session_id)
            self.redis_client.delete(f"session:{session_id}")
            
            # Release port
            self._release_port(session['neko_port'])
            
            logger.info(f"Session destroyed: {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to destroy session: {e}")
            return False

    def cleanup_expired_sessions(self):
        """Remove sessions that have exceeded timeout"""
        cursor = 0
        while True:
            cursor, keys = self.redis_client.scan(cursor, match="session:*", count=100)
            for key in keys:
                session_data = self.redis_client.get(key)
                if session_data:
                    session = json.loads(session_data)
                    expires = datetime.fromisoformat(session['expires_at'])
                    if datetime.utcnow() > expires:
                        session_id = session['session_id']
                        logger.info(f"Expiring session: {session_id}")
                        self.destroy_session(session_id)
            
            if cursor == 0:
                break

    def health_check(self, session_id: str) -> Dict:
        """Check if container is healthy"""
        try:
            session_data = self.redis_client.get(f"session:{session_id}")
            if not session_data:
                return {'healthy': False, 'reason': 'Session not found'}
            
            session = json.loads(session_data)
            container_id = session['container_id']
            
            try:
                container = self.docker_client.containers.get(container_id)
                status = container.status
                
                if status == 'running':
                    # Check if Neko process is responsive
                    try:
                        exec_result = container.exec_run(
                            'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health'
                        )
                        http_code = exec_result.output.decode().strip()
                        healthy = http_code == '200'
                        return {
                            'healthy': healthy,
                            'status': status,
                            'http_code': http_code,
                        }
                    except Exception as e:
                        return {'healthy': False, 'status': status, 'error': str(e)}
                else:
                    return {'healthy': False, 'status': status}
                    
            except docker.errors.NotFound:
                return {'healthy': False, 'reason': 'Container not found'}
                
        except Exception as e:
            return {'healthy': False, 'error': str(e)}

    def _allocate_port(self) -> int:
        """Find next available port for Neko"""
        for port in range(self.neko_port_base, self.neko_port_base + 1000):
            if not self.redis_client.get(f"port:{port}"):
                self.redis_client.setex(f"port:{port}", 86400, "allocated")
                return port
        raise RuntimeError("No available ports for Neko")

    def _release_port(self, port: int):
        """Release allocated port"""
        self.redis_client.delete(f"port:{port}")

    def _generate_wireguard_config(self, user_id: str, session_id: str) -> Dict:
        """Generate per-session WireGuard configuration"""
        import subprocess
        
        # Generate ephemeral keypair
        private_key = subprocess.check_output(
            'wg genkey', shell=True, text=True
        ).strip()
        public_key = subprocess.check_output(
            f'echo "{private_key}" | wg pubkey', shell=True, text=True
        ).strip()
        
        # Allocate IP address for this session
        session_hash = int(hashlib.md5(f"{user_id}:{session_id}".encode()).hexdigest(), 16)
        ip_suffix = (session_hash % 254) + 2  # 10.0.0.2 - 10.0.0.255
        client_ip = f"10.0.0.{ip_suffix}"
        
        config = {
            'WG_PRIVATE_KEY': private_key,
            'WG_PUBLIC_KEY': public_key,
            'WG_CLIENT_IP': client_ip,
            'WG_SERVER_IP': '10.0.0.1',
            'WG_ENDPOINT': f"{os.getenv('SERVER_PUBLIC_IP', 'localhost')}:51820",
        }
        
        # Store for future reference
        self.redis_client.setex(
            f"wg_config:{session_id}",
            self.session_timeout,
            json.dumps(config)
        )
        
        return config

async def run_cleanup_loop():
    """Periodically clean up expired sessions"""
    manager = SessionManager()
    while True:
        try:
            manager.cleanup_expired_sessions()
        except Exception as e:
            logger.error(f"Cleanup error: {e}")
        await asyncio.sleep(60)  # Run every minute

if __name__ == '__main__':
    manager = SessionManager()
    
    # Test
    session = manager.create_session('test-user', {})
    print(f"Created: {session}")
    
    health = manager.health_check(session['session_id'])
    print(f"Health: {health}")
    
    # manager.destroy_session(session['session_id'])
```

### 4.2 FastAPI Endpoint Integration

In MCP server, add endpoint to `app.py`:

```python
from fastapi import FastAPI, HTTPException
from session_manager import SessionManager

app = FastAPI()
session_manager = SessionManager()

@app.post("/api/v1/sessions")
async def create_session(user_id: str, config: dict = None):
    """Create a new browser session"""
    try:
        session = session_manager.create_session(user_id, config or {})
        return {
            'success': True,
            'session': session
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str):
    """Get session details"""
    data = session_manager.redis_client.get(f"session:{session_id}")
    if not data:
        raise HTTPException(status_code=404, detail="Session not found")
    return json.loads(data)

@app.delete("/api/v1/sessions/{session_id}")
async def delete_session(session_id: str):
    """Destroy a session"""
    success = session_manager.destroy_session(session_id)
    return {
        'success': success,
        'session_id': session_id
    }

@app.get("/api/v1/sessions/{session_id}/health")
async def session_health(session_id: str):
    """Check session health"""
    health = session_manager.health_check(session_id)
    return health
```

---

## 5. WireGuard & Network Isolation

### 5.1 Server-Side WireGuard Setup

Create `/opt/remotebrowser/scripts/wireguard-setup.sh`:

```bash
#!/bin/bash
set -euo pipefail

# WireGuard setup for server
INTERFACE="wg0"
SERVER_IP="10.0.0.1"
SUBNET="10.0.0.0/24"
LISTEN_PORT="51820"

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# Load module
modprobe wireguard

# Create interface
ip link add dev ${INTERFACE} type wireguard
ip addr add ${SERVER_IP}/24 dev ${INTERFACE}
ip link set ${INTERFACE} up

# Set listen port
wg set ${INTERFACE} listen-port ${LISTEN_PORT}

# Allow WireGuard to forward traffic
iptables -A FORWARD -i ${INTERFACE} -j ACCEPT
iptables -A FORWARD -o ${INTERFACE} -j ACCEPT
iptables -A FORWARD -i eth0 -o ${INTERFACE} -j ACCEPT
iptables -A FORWARD -i ${INTERFACE} -o eth0 -j ACCEPT

# NAT for outbound traffic
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE

# Save iptables rules
iptables-save > /etc/iptables/rules.v4

# Persist WireGuard interface
cat > /etc/wireguard/${INTERFACE}.conf <<EOF
[Interface]
Address = ${SERVER_IP}/24
SaveConfig = false
ListenPort = ${LISTEN_PORT}
PrivateKey = $(cat /etc/wireguard/server_private.key)

PostUp = ip rule add from ${SERVER_IP}/24 table 200; ip route add default via %i table 200
PostDown = ip rule del from ${SERVER_IP}/24 table 200; ip route del default via %i table 200
EOF

chmod 600 /etc/wireguard/${INTERFACE}.conf

# Start WireGuard
systemctl restart wg-quick@${INTERFACE}

echo "✓ WireGuard server ready on ${INTERFACE}:${LISTEN_PORT}"
```

### 5.2 Per-Session Client Configuration

Python function in `session_manager.py`:

```python
def generate_client_wireguard_config(self, user_id: str, session_id: str, server_public_ip: str) -> str:
    """
    Generate WireGuard client config for user to import on their device
    User runs: sudo wg-quick up <config-name>
    """
    import subprocess
    
    # Get stored config
    config_json = self.redis_client.get(f"wg_config:{session_id}")
    if not config_json:
        raise ValueError(f"Config not found for {session_id}")
    
    config = json.loads(config_json)
    
    # Server public key (pre-generated)
    with open('/etc/wireguard/server_public.key', 'r') as f:
        server_public_key = f.read().strip()
    
    # Generate .conf format for user
    client_config = f"""
[Interface]
Address = {config['WG_CLIENT_IP']}/32
PrivateKey = {config['WG_PRIVATE_KEY']}
DNS = 1.1.1.1  # Cloudflare DNS
Table = off

[Peer]
PublicKey = {server_public_key}
AllowedIPs = 10.0.0.0/24
Endpoint = {server_public_ip}:51820
PersistentKeepalive = 25
"""
    
    return client_config.strip()
```

### 5.3 Network Namespace Isolation (Optional, Advanced)

For strong isolation, run browser in separate network namespace:

```bash
#!/bin/bash
# In container init script

SESSION_ID=$1
CLIENT_IP=$2

# Create dedicated netns for this browser
ip netns add browser-${SESSION_ID}

# Move WireGuard interface into namespace
ip link set wg0 netns browser-${SESSION_ID}
ip netns exec browser-${SESSION_ID} ip addr add ${CLIENT_IP}/32 dev wg0
ip netns exec browser-${SESSION_ID} ip link set wg0 up

# All Chrome processes run in this namespace
# exec ip netns exec browser-${SESSION_ID} /usr/bin/chromium-browser ...
```

---

## 6. Neko/noVNC Setup

### 6.1 Browser Container Dockerfile

Create `/opt/remotebrowser/containers/browser/Dockerfile`:

```dockerfile
FROM ubuntu:24.04

# Disable interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl wget \
    xvfb x11-utils xauth \
    chromium-browser chromium-chromedriver \
    fontconfig fonts-liberation \
    ffmpeg \
    pulseaudio \
    supervisor \
    ca-certificates \
    openbox \
    # WireGuard client
    wireguard wireguard-tools \
    # Development tools
    git openssh-client \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Neko (WebRTC browser streaming)
# https://github.com/m1k1o/neko/releases
ARG NEKO_VERSION=3.0.0
RUN wget -O /tmp/neko.tar.gz \
    https://github.com/m1k1o/neko/releases/download/v${NEKO_VERSION}/neko-linux-x64-slim.tar.gz && \
    tar -xzf /tmp/neko.tar.gz -C /usr/local/bin && \
    rm /tmp/neko.tar.gz

# Create appuser
RUN useradd -m -s /bin/bash appuser && \
    mkdir -p /home/appuser/Downloads && \
    chown -R appuser:appuser /home/appuser

# Setup Xvfb + openbox + Neko
RUN mkdir -p /etc/supervisor/conf.d

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080  # Neko WebRTC
EXPOSE 5900  # VNC fallback
EXPOSE 9222  # Chrome DevTools

USER appuser
WORKDIR /home/appuser

ENTRYPOINT ["/entrypoint.sh"]
```

### 6.2 supervisord.conf

Create `/opt/remotebrowser/containers/browser/supervisord.conf`:

```ini
[supervisord]
nodaemon=true
user=appuser
logfile=/tmp/supervisord.log

[program:xvfb]
command=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX
autostart=true
autorestart=true
startsecs=1
priority=100
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

[program:openbox]
command=/usr/bin/openbox --startup /bin/bash -c 'sleep infinity'
environment=DISPLAY=:99
autostart=true
autorestart=true
startsecs=1
priority=200
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

[program:chromium]
command=bash -c '/usr/bin/chromium-browser --no-first-run --no-default-browser-check --disable-default-apps --disable-extensions --disable-background-networking --disable-client-side-phishing-detection --disable-background-timer-throttling --no-service-autorun --disable-sync --metrics-recording-only --user-data-dir=/tmp/chromium --disable-default-apps --disable-extensions --mute-audio --disable-gpu --window-size=1920,1080 --no-sandbox --disable-dev-shm-usage about:blank'
environment=DISPLAY=:99
autostart=true
autorestart=true
startsecs=5
priority=300
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

[program:neko]
command=bash -c '/usr/local/bin/neko serve --bind :8080'
environment=DISPLAY=:99,NEKO_PASSWORD=,NEKO_SCREEN=1920x1080
autostart=true
autorestart=true
startsecs=5
priority=400
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0

# Optional: VNC server for fallback
[program:vncserver]
command=/usr/bin/vncserver :5900 -geometry 1920x1080 -depth 24 -noxstartup
environment=DISPLAY=:99
autostart=false
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
```

### 6.3 entrypoint.sh

Create `/opt/remotebrowser/containers/browser/entrypoint.sh`:

```bash
#!/bin/bash
set -e

# Load WireGuard config if provided
if [ -n "${WG_PRIVATE_KEY}" ]; then
    echo "Setting up WireGuard..."
    
    # Create WireGuard config
    cat > /tmp/wg0.conf <<EOF
[Interface]
Address = ${WG_CLIENT_IP}/32
PrivateKey = ${WG_PRIVATE_KEY}
DNS = 1.1.1.1

[Peer]
PublicKey = ${WG_SERVER_PUBKEY}
AllowedIPs = 10.0.0.0/24
Endpoint = ${WG_ENDPOINT}
PersistentKeepalive = 25
EOF
    
    sudo ip netns exec browser-${SESSION_ID} \
        wg-quick up /tmp/wg0.conf &
fi

# Start supervisor
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
```

### 6.4 URL Routing (Caddy)

Update Caddyfile to route Neko URLs:

```caddyfile
# Dynamic Neko endpoint
*.neko.{$DOMAIN} {
    # Extract session_id from subdomain
    @neko_session {
        path /neko/*
    }

    # Proxy to Docker container on dynamic port
    # This requires intelligent routing from MCP
    reverse_proxy mcp-server:8000 {
        header_up X-Neko-Session {http.request.host}
    }

    log {
        output stdout
        format json
    }
}
```

MCP server intercepts and routes to correct container:

```python
@app.get("/neko/{session_id}/ws")
async def neko_websocket(session_id: str, websocket: WebSocket):
    """WebSocket proxy to Neko stream"""
    session_data = session_manager.redis_client.get(f"session:{session_id}")
    if not session_data:
        raise HTTPException(status_code=404)
    
    session = json.loads(session_data)
    neko_port = session['neko_port']
    
    # Proxy WebSocket to container's Neko instance
    # Use websockets library or similar
    uri = f"ws://172.20.0.{session_id[-2:]}:8080/ws"  # Dynamic IP
    # ... proxy logic
```

---

## 7. Monitoring Stack

### 7.1 Prometheus Configuration

Create `/opt/remotebrowser/configs/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    monitor: 'remotebrowser'
    environment: 'production'

alerting:
  alertmanagers:
    - static_configs:
        - targets: []

rule_files:
  - 'alert_rules.yml'

scrape_configs:
  # Node exporter (system metrics)
  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']
        labels:
          instance: 'server'

  # Docker daemon metrics
  - job_name: 'docker'
    static_configs:
      - targets: ['localhost:9323']

  # MCP server metrics
  - job_name: 'mcp-server'
    static_configs:
      - targets: ['mcp-server:8001']
    metrics_path: '/metrics'

  # Redis metrics
  - job_name: 'redis'
    static_configs:
      - targets: ['redis:6379']

  # cAdvisor (container metrics)
  - job_name: 'cadvisor'
    static_configs:
      - targets: ['cadvisor:8080']
```

### 7.2 Alert Rules

Create `/opt/remotebrowser/configs/alert_rules.yml`:

```yaml
groups:
  - name: remotebrowser
    interval: 15s
    rules:
      # High memory usage
      - alert: HighMemoryUsage
        expr: (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) < 0.1
        for: 5m
        annotations:
          summary: "Server memory <10% available"

      # High CPU usage
      - alert: HighCPUUsage
        expr: rate(node_cpu_seconds_total[5m]) > 0.8
        for: 10m
        annotations:
          summary: "CPU usage >80% for 10 minutes"

      # Container crashes
      - alert: ContainerCrashing
        expr: |
          rate(container_last_seen{name=~"browser-.*"}[5m]) < 0.1
        for: 2m
        annotations:
          summary: "Browser container {{ $labels.name }} is restarting frequently"

      # Redis connection issues
      - alert: RedisDown
        expr: redis_up == 0
        for: 1m
        annotations:
          summary: "Redis is down"

      # Neko stream latency
      - alert: HighStreamLatency
        expr: histogram_quantile(0.95, neko_stream_latency_ms) > 200
        for: 5m
        annotations:
          summary: "P95 stream latency >200ms"
```

### 7.3 Grafana Dashboard (JSON)

Create `/opt/remotebrowser/configs/grafana/dashboards/overview.json`:

```json
{
  "dashboard": {
    "title": "Remote Browser MCP Overview",
    "panels": [
      {
        "title": "Active Sessions",
        "targets": [
          {
            "expr": "redis_keys_total{database=\"0\",keypattern=\"session:*\"}"
          }
        ]
      },
      {
        "title": "Container Memory Usage",
        "targets": [
          {
            "expr": "container_memory_usage_bytes{name=~\"browser-.*\"} / 1024 / 1024"
          }
        ]
      },
      {
        "title": "Container CPU Usage",
        "targets": [
          {
            "expr": "rate(container_cpu_usage_seconds_total{name=~\"browser-.*\"}[5m]) * 100"
          }
        ]
      },
      {
        "title": "Network Throughput",
        "targets": [
          {
            "expr": "rate(node_network_receive_bytes_total{device=\"eth0\"}[5m]) / 1024 / 1024"
          }
        ]
      }
    ]
  }
}
```

---

## 8. CI/CD Pipeline (GitHub Actions)

### 8.1 .github/workflows/deploy.yml

```yaml
name: Deploy to Hetzner

on:
  push:
    branches: [main]
    paths:
      - 'services/**'
      - 'containers/**'
      - 'docker-compose.yml'
      - '.github/workflows/deploy.yml'

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to Registry
        uses: docker/login-action@v2
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push MCP image
        uses: docker/build-push-action@v4
        with:
          context: ./services/mcp
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/mcp:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/mcp:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build and push Browser image
        uses: docker/build-push-action@v4
        with:
          context: ./containers/browser
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/chrome-neko:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/chrome-neko:${{ github.sha }}

  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Pull and test images
        run: |
          docker pull ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/mcp:${{ github.sha }}
          docker pull ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/chrome-neko:${{ github.sha }}
          docker run --rm ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/mcp:${{ github.sha }} pytest tests/

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3

      - name: Deploy to Hetzner
        env:
          DEPLOY_KEY: ${{ secrets.HETZNER_DEPLOY_KEY }}
          DEPLOY_HOST: ${{ secrets.HETZNER_HOST }}
          DEPLOY_USER: ubuntu
        run: |
          mkdir -p ~/.ssh
          echo "$DEPLOY_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          
          ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no \
            $DEPLOY_USER@$DEPLOY_HOST \
            'cd /opt/remotebrowser/deploy && \
             git pull origin main && \
             docker compose pull && \
             docker compose up -d'

      - name: Verify Deployment
        env:
          DEPLOY_HOST: ${{ secrets.HETZNER_HOST }}
        run: |
          sleep 10
          curl -f http://$DEPLOY_HOST/health || exit 1
```

### 8.2 .github/workflows/test.yml

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379

    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-python@v4
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: |
          pip install -r requirements.txt
          pip install pytest pytest-asyncio

      - name: Run tests
        env:
          REDIS_URL: redis://localhost:6379/0
        run: |
          pytest tests/ -v --cov=services --cov-report=xml

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage.xml
```

---

## 9. Scaling Playbook

### 9.1 Multi-Server Setup (3-Node Cluster)

**Hardware per node**: Hetzner AX41-NVMe

**Architecture**:
```
Load Balancer (Hetzner LB or HAProxy)
    ├─ Node 1: MCP (control) + Browser instances
    ├─ Node 2: Browser instances only
    └─ Node 3: Browser instances only

Shared Services:
    ├─ Redis (standalone or cluster)
    ├─ PostgreSQL (sessions, user data)
    └─ Prometheus + Grafana (monitoring)
```

### 9.2 Deployment Script for Multi-Node

Save as `/opt/remotebrowser/scripts/scale-up.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Add new Hetzner server to cluster
# Usage: ./scale-up.sh <new_server_ip> <node_name>

NEW_SERVER_IP=${1}
NODE_NAME=${2:-"remotebrowser-$(date +%s)"}

echo "Adding $NODE_NAME at $NEW_SERVER_IP"

# Provision new server
ssh -o StrictHostKeyChecking=no \
    root@${NEW_SERVER_IP} \
    bash < /opt/remotebrowser/scripts/provision-hetzner.sh

# Install Nomad agent (if using Nomad)
ssh ubuntu@${NEW_SERVER_IP} \
    "curl -fsSL https://apt.releases.hashicorp.com/gpg | sudo apt-key add - && \
     sudo apt-add-repository 'deb [arch=amd64] https://apt.releases.hashicorp.com $(lsb_release -cs) main' && \
     sudo apt-get update && \
     sudo apt-get install nomad && \
     sudo systemctl enable nomad && \
     sudo systemctl start nomad"

# Configure Nomad to join cluster
ssh ubuntu@${NEW_SERVER_IP} \
    "sudo nomad server join $PRIMARY_NODE_IP" || \
    "sudo nomad agent -node=$NODE_NAME -servers $PRIMARY_NODE_IP"

# Update load balancer to include new node
# (Depends on your load balancer setup)
echo "Update your load balancer config to include $NEW_SERVER_IP"

echo "✓ Node $NODE_NAME ready"
```

### 9.3 Load Balancing

**Option A: Hetzner Load Balancer (Managed)**

```bash
# Create via Hetzner Cloud API
curl -X POST "https://api.hetzner.cloud/v1/load_balancers" \
  -H "Authorization: Bearer $HETZNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "remotebrowser-lb",
    "load_balancer_type": "lb11",
    "network_zone": "eu-central",
    "algorithm": {
      "type": "round_robin"
    },
    "services": [
      {
        "protocol": "http",
        "listen_port": 80,
        "destination_port": 80,
        "proxyprotocol": false
      },
      {
        "protocol": "https",
        "listen_port": 443,
        "destination_port": 443,
        "proxyprotocol": false
      }
    ]
  }'
```

**Option B: HAProxy (Self-Hosted)**

```haproxy
global
    maxconn 4096
    daemon
    log 127.0.0.1 local0
    log 127.0.0.1 local1 notice

defaults
    log     global
    mode    http
    option  httplog
    option  dontlognull
    timeout connect 5000
    timeout client  50000
    timeout server  50000

frontend http-in
    bind *:80
    bind *:443 ssl crt /etc/ssl/certs/remotebrowser.pem
    redirect scheme https code 301 if !{ ssl_fc }
    default_backend browsers

backend browsers
    balance roundrobin
    server browser1 <node1-ip>:8000 check
    server browser2 <node2-ip>:8000 check
    server browser3 <node3-ip>:8000 check
```

### 9.4 Session State Sharing (Redis Cluster)

For multi-node, use Redis Cluster for HA:

```bash
# Redis Cluster setup (3 nodes, high availability)
docker run -d --name redis-node-1 \
  --net host \
  redis:7-alpine redis-server --cluster-enabled yes --port 6379

docker run -d --name redis-node-2 \
  --net host \
  redis:7-alpine redis-server --cluster-enabled yes --port 6380

docker run -d --name redis-node-3 \
  --net host \
  redis:7-alpine redis-server --cluster-enabled yes --port 6381

# Initialize cluster
redis-cli -p 6379 --cluster create \
    127.0.0.1:6379 \
    127.0.0.1:6380 \
    127.0.0.1:6381
```

### 9.5 Capacity Planning

```
Per Node (AX41-NVMe):
  - RAM: 64GB
  - CPU: 6 cores
  - Concurrent sessions: 25-40

Scaling Formula:
  N_nodes = ceil(target_sessions / 35)
  
Example:
  - 50 sessions → 2 nodes
  - 100 sessions → 3 nodes
  - 200 sessions → 6 nodes

Session Type Overhead:
  - Idle: 200MB RAM, 0.1 CPU
  - Active: 450MB RAM, 1 CPU
  - Peak (with video): 600MB RAM, 1.5 CPU

Cost (EU-Central, 2025):
  - Single AX41: €40/month ≈ €0.1 per concurrent session/month
  - 3x AX41: €120/month ≈ €0.06 per concurrent session/month (economy of scale)
```

---

## 10. Deployment Checklist

### Pre-Deployment
- [ ] Domain registered & DNS configured
- [ ] SSH keys generated (`ssh-keygen -t ed25519`)
- [ ] Hetzner account & API token ready
- [ ] GitHub repo created with deploy key
- [ ] SSL certificates ready (Let's Encrypt via Caddy)

### Deployment
- [ ] Provision Hetzner server: `provision-hetzner.sh`
- [ ] Clone deployment repo to `/opt/remotebrowser/deploy`
- [ ] Create `.env` file with configuration
- [ ] Build Docker images: `docker compose build`
- [ ] Start services: `docker compose up -d`
- [ ] Verify health checks: `docker compose ps`

### Post-Deployment
- [ ] Test MCP API: `curl https://remotebrowser.example.com/api/v1/health`
- [ ] Create test session: POST `/api/v1/sessions`
- [ ] Access Grafana: `https://grafana.remotebrowser.example.com`
- [ ] Verify Prometheus scraping: `https://prometheus.remotebrowser.example.com`
- [ ] Test WireGuard client connection
- [ ] Load test with k6 or similar

### Monitoring
- [ ] Set up alerting (Slack/PagerDuty)
- [ ] Configure log aggregation (ELK/Loki)
- [ ] Monitor memory/CPU trends
- [ ] Track session creation/failure rates

---

## References

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Caddy Documentation](https://caddyserver.com/docs/)
- [WireGuard Quick Start](https://www.wireguard.com/quickstart/)
- [Neko GitHub](https://github.com/m1k1o/neko)
- [Hetzner Cloud API](https://docs.hetzner.cloud/)
- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)

---

**Document Date**: April 2026  
**Status**: Deployment Ready  
**Last Updated**: 2026-04-13
