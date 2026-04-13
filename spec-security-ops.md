# Security Hardening and Operations Specification

**Project:** Hosted Browser MCP Service  
**Target Platform:** Hetzner, Ubuntu 24.04 LTS  
**Audience:** DevOps engineers, security engineers, operations teams  
**Status:** Operational Playbook v1.0  
**Last Updated:** 2026-04-13

---

## Table of Contents

1. [Server Hardening](#1-server-hardening)
2. [Container Security](#2-container-security)
3. [Network Security](#3-network-security)
4. [Auth & Secrets Management](#4-auth--secrets-management)
5. [Multi-Tenant Isolation Checklist](#5-multi-tenant-isolation-checklist)
6. [Incident Response Procedures](#6-incident-response-procedures)
7. [Compliance Roadmap](#7-compliance-roadmap)
8. [Operational Runbooks](#8-operational-runbooks)

---

## 1. Server Hardening

### 1.1 Initial System Setup

#### Disk Encryption (LUKS)

Hetzner offers full disk encryption at provisioning. **Mandatory for production.**

```bash
# Verify on existing system (should see dm-x entries)
lsblk | grep crypt

# If not encrypted, enable at next reboot (Hetzner console)
# Settings → Storage → Full Disk Encryption → Enable
```

#### Partition Layout (Recommended)

```
/        (root, 50 GB)         - EXT4, encrypted
/home    (20 GB)               - EXT4, encrypted (user data)
/var     (30 GB)               - EXT4, encrypted (logs, containers)
/tmp     (10 GB)               - EXT4, noexec, nosuid (prevent exec from /tmp)
swap     (4 GB)                - Encrypted
```

### 1.2 SSH Hardening

#### SSH Configuration (`/etc/ssh/sshd_config`)

```bash
# Create backup
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak

# Edit config
sudo nano /etc/ssh/sshd_config
```

```ini
# SSH Hardening Configuration

# Network Settings
Port 22
AddressFamily any
ListenAddress 0.0.0.0
ListenAddress ::

# Authentication
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
PermitEmptyPasswords no
MaxAuthTries 3
MaxSessions 5

# Key Exchange & Crypto
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes256-ctr
MACs hmac-sha2-512-etm@openssh.org,hmac-sha2-256-etm@openssh.org
HostKeyAlgorithms ssh-ed25519

# Access Control
AllowUsers deploy monitoring
DenyUsers root
AllowAgentForwarding no
AllowTcpForwarding no
PermitTunnel no
X11Forwarding no

# Session
ClientAliveInterval 300
ClientAliveCountMax 2
TCPKeepAlive yes
Compression delayed

# Logging
SyslogFacility AUTH
LogLevel VERBOSE

# SFTP (disable if not needed)
# Subsystem sftp /usr/lib/openssh/sftp-server -f AUTHPRIV -l INFO
```

**Apply & test:**
```bash
# Syntax check
sudo sshd -t

# Reload daemon (test first in another session!)
sudo systemctl reload ssh

# Verify config
sudo sshctl -G | grep -E "PermitRootLogin|PasswordAuthentication"
```

#### SSH Key Management

```bash
# Generate ed25519 key (on local machine, not on server)
ssh-keygen -t ed25519 -C "deploy@remotebrowser-prod" -f ~/.ssh/id_remotebrowser_prod

# Add to server
ssh-copy-id -i ~/.ssh/id_remotebrowser_prod.pub deploy@<server_ip>

# Verify access (no password prompt)
ssh -i ~/.ssh/id_remotebrowser_prod deploy@<server_ip> "whoami"

# Disable password auth on server
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload ssh
```

### 1.3 Firewall Configuration (UFW)

```bash
# Reset to defaults (if needed)
sudo ufw reset

# Default policies
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (from admin networks)
sudo ufw allow from 203.0.113.0/24 to any port 22 proto tcp comment "Admin SSH"
sudo ufw allow from 198.51.100.0/24 to any port 22 proto tcp comment "Admin SSH"

# Allow HTTP/HTTPS (for MCP clients)
sudo ufw allow 443/tcp comment "HTTPS - MCP Clients"
sudo ufw allow 80/tcp comment "HTTP - Redirect to HTTPS"

# Allow WireGuard (VPN to private networks)
sudo ufw allow 51820/udp comment "WireGuard VPN"

# Enable firewall
sudo ufw enable

# Verify
sudo ufw status verbose
```

**UFW Logging:**
```bash
# Enable logging (rate limited)
sudo ufw logging on
sudo ufw logging medium

# View logs
sudo tail -f /var/log/ufw.log

# High traffic detection
sudo grep "DPT=22" /var/log/ufw.log | wc -l
```

### 1.4 Fail2Ban Installation & Configuration

```bash
# Install
sudo apt update && sudo apt install -y fail2ban fail2ban-doc

# Create local config (don't edit /etc/fail2ban/fail2ban.conf directly)
sudo nano /etc/fail2ban/fail2ban.local
```

```ini
[DEFAULT]
# Logging
loglevel = INFO
logtarget = /var/log/fail2ban.log

# Ban settings
bantime = 3600
findtime = 600
maxretry = 3

# Action: ban + send email alert (requires postfix)
action = %(action_mwl)s
```

```bash
# SSH jail config
sudo nano /etc/fail2ban/jail.local
```

```ini
[DEFAULT]
destemail = security@company.example
sendername = Fail2Ban Alert
action = %(action_mwl)s

[sshd]
enabled = true
port = 22
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
findtime = 600
bantime = 3600

[sshd-ddos]
enabled = true
port = 22
filter = sshd-ddos
logpath = /var/log/auth.log
maxretry = 10
findtime = 60
bantime = 600
action = iptables-multiport[name=SSH, port="ssh,http,https"]
```

**Activate:**
```bash
sudo systemctl restart fail2ban

# Monitor
sudo fail2ban-client status
sudo fail2ban-client status sshd

# Manually unban IP if needed
sudo fail2ban-client set sshd unbanip 203.0.113.5
```

### 1.5 Unattended Security Updates

```bash
# Install
sudo apt install -y unattended-upgrades apt-listchanges

# Configure
sudo nano /etc/apt/apt.conf.d/50unattended-upgrades
```

```ini
// Auto-install security updates
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};

// Auto-reboot if needed (after 3am local time)
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";

// Mail notifications
Unattended-Upgrade::Mail "root";
Unattended-Upgrade::MailOnlyOnError "true";

// Packages to exclude (if needed)
Unattended-Upgrade::Package-Blacklist {
    // "postgresql";
};

// Auto-remove unused packages
APT::AutoRemove::Packages {
    "postgresql-client";
};

// Remove unused kernel versions
APT::Remove-Unused-Kernel-Packages "true";
```

```bash
# Enable autoupdate
sudo nano /etc/apt/apt.conf.d/20auto-upgrades
```

```ini
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Reboot "0";
```

**Verify:**
```bash
sudo systemctl status unattended-upgrades
sudo unattended-upgrade --dry-run
```

### 1.6 Kernel Hardening Parameters

```bash
# Edit sysctl config
sudo nano /etc/sysctl.d/99-hardening.conf
```

```ini
# Kernel Protection
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.printk = 3 3 3 3
kernel.unprivileged_ns_clone = 0
kernel.unprivileged_bpf_disabled = 1
kernel.unprivileged_userns_clone = 0

# ExecShield / DEP / NX
kernel.exec-shield = 1

# ASLR (Address Space Layout Randomization)
kernel.randomize_va_space = 2

# Restrict access to sysrq
kernel.sysrq = 0

# Restrict ptrace scope (prevent debugging other processes)
kernel.yama.ptrace_scope = 2

# Module loading
kernel.modules_disabled = 1

# Restrict IP forwarding (enable for WireGuard namespace routing)
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_syn_retries = 2
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_max_syn_backlog = 4096

# Ignore ICMP redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Ignore bogus ICMP error responses
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Reverse path filtering (anti-spoofing)
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# TCP hardening
net.ipv4.tcp_timestamps = 0
net.ipv4.tcp_rfc1337 = 1

# Disable ICMP redirects (except for LL scope)
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Increase file descriptor limits
fs.file-max = 1048576
fs.inotify.max_user_watches = 524288

# Prevent core dumps (sensitive data leak risk)
kernel.core_pattern = |/bin/true
fs.suid_dumpable = 0
```

**Apply:**
```bash
sudo sysctl -p /etc/sysctl.d/99-hardening.conf

# Verify
sysctl kernel.randomize_va_space
sysctl net.ipv4.tcp_syncookies
```

### 1.7 Audit Logging (auditd)

```bash
# Install
sudo apt install -y auditd audispd-plugins

# Edit audit rules
sudo nano /etc/audit/rules.d/remotebrowser.rules
```

```ini
# Remove any existing rules
-D

# Buffer Size
-b 8192

# Failure Mode
-f 1

# Monitor SSH configuration changes
-w /etc/ssh/ -p wa -k ssh_config_changes
-w /etc/ssh/sshd_config -p wa -k sshd_config_change

# Monitor sudo usage
-w /etc/sudoers -p wa -k sudo_changes
-w /etc/sudoers.d/ -p wa -k sudoers_changes

# Monitor user/group changes
-w /etc/passwd -p wa -k user_changes
-w /etc/shadow -p wa -k shadow_changes
-w /etc/group -p wa -k group_changes

# Monitor filesystem for unauthorized changes
-w /usr/bin -p wa -k binary_changes
-w /usr/sbin -p wa -k binary_changes

# Monitor Docker daemon
-w /usr/bin/docker -p wa -k docker_changes
-w /etc/docker -p wa -k docker_config_changes

# Monitor WireGuard
-w /etc/wireguard -p wa -k wireguard_config_changes

# Monitor system calls (resource exhaustion detection)
-a always,exit -F arch=b64 -S execve -F exe=/usr/bin/docker -k docker_exec
-a always,exit -F arch=b64 -S open -F name=/var/www/remotebrowsermcp -k app_file_access

# Make rules immutable (prevent tampering)
-e 2
```

**Load rules:**
```bash
sudo service auditd restart
sudo auditctl -l  # List active rules

# Monitor logs
sudo tail -f /var/log/audit/audit.log
```

---

## 2. Container Security

### 2.1 Docker Daemon Hardening

#### Install Docker (Ubuntu 24.04)

```bash
# Add Docker repository
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

#### Enable Rootless Mode

```bash
# Install rootless docker
dockerd-rootless-setuptool.sh install

# Verify
docker ps

# Configure to auto-start on reboot
systemctl --user enable docker
sudo loginctl enable-linger $(whoami)
```

#### Docker Daemon Configuration (`/etc/docker/daemon.json`)

```bash
sudo nano /etc/docker/daemon.json
```

```json
{
  "debug": false,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3",
    "labels": "service=browsermcp"
  },
  "icc": false,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 64000,
      "Soft": 64000
    }
  },
  "seccomp-profile": "/etc/docker/seccomp.json",
  "userns-remap": "default",
  "storage-driver": "overlay2",
  "live-restore": true,
  "userland-proxy": false,
  "seccomp-profile": "/etc/docker/seccomp.json"
}
```

**Restart daemon:**
```bash
sudo systemctl restart docker
sudo docker ps  # Verify still works
```

### 2.2 Seccomp Profile for Browser Containers

Create strict seccomp profile to prevent dangerous syscalls:

```bash
sudo nano /etc/docker/seccomp.json
```

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "archMap": [
    {
      "architecture": "x86_64",
      "subArches": [
        "x86",
        "x32"
      ]
    }
  ],
  "syscalls": [
    {
      "names": [
        "accept4",
        "arch_prctl",
        "bind",
        "brk",
        "clone",
        "clone3",
        "close",
        "connect",
        "dup",
        "dup2",
        "dup3",
        "epoll_create1",
        "epoll_ctl",
        "epoll_wait",
        "exit",
        "exit_group",
        "fcntl",
        "flock",
        "fstat",
        "fstatat",
        "futex",
        "futex_waitv",
        "getcwd",
        "getegid",
        "geteuid",
        "getgid",
        "getgroups",
        "getpgrp",
        "getpid",
        "getppid",
        "getrandom",
        "getrlimit",
        "getrusage",
        "getsockname",
        "getsockopt",
        "gettimeofday",
        "getuid",
        "listen",
        "lseek",
        "madvise",
        "mmap",
        "mprotect",
        "mremap",
        "msync",
        "munmap",
        "nanosleep",
        "open",
        "openat",
        "openat2",
        "pipe",
        "pipe2",
        "poll",
        "ppoll",
        "prctl",
        "pread64",
        "prlimit64",
        "pselect6",
        "pwrite64",
        "read",
        "readv",
        "recvfrom",
        "recvmmsg",
        "recvmsg",
        "rseq",
        "rt_sigaction",
        "rt_sigpending",
        "rt_sigprocmask",
        "rt_sigreturn",
        "rt_sigsuspend",
        "sched_getaffinity",
        "sched_setaffinity",
        "sched_yield",
        "select",
        "semget",
        "semop",
        "sendmmsg",
        "sendmsg",
        "sendto",
        "setgid",
        "setgroups",
        "sethostname",
        "setitimer",
        "setpgid",
        "setpriority",
        "setregid",
        "setresgid",
        "setresuid",
        "setreuid",
        "setrlimit",
        "setsid",
        "setsockopt",
        "setuid",
        "shutdown",
        "sigaltstack",
        "socket",
        "socketpair",
        "stat",
        "statx",
        "statfs",
        "statfs64",
        "statvfs",
        "statvfs64",
        "sync",
        "sysinfo",
        "time",
        "timer_create",
        "timer_delete",
        "timer_getoverrun",
        "timer_gettime",
        "timer_settime",
        "timerfd_create",
        "timerfd_gettime",
        "timerfd_settime",
        "times",
        "tgkill",
        "tkill",
        "truncate",
        "umask",
        "uname",
        "unlink",
        "unlinkat",
        "utime",
        "utimensat",
        "utimes",
        "vfork",
        "wait4",
        "waitid",
        "waitpid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": [
        "ptrace",
        "process_vm_readv",
        "process_vm_writev",
        "mount",
        "umount2",
        "reboot",
        "kexec_load",
        "keyctl",
        "add_key",
        "request_key",
        "syslog",
        "sysrq",
        "loadkeys",
        "finit_module",
        "init_module",
        "delete_module",
        "ioperm",
        "iopl",
        "ioctl"
      ],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1
    }
  ]
}
```

### 2.3 AppArmor Profile for Browser Container

```bash
sudo nano /etc/apparmor.d/docker-browser
```

```
#include <tunables/global>

profile docker-browser flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  
  # Allow capability for normal operation
  capability sys_chroot,
  capability setuid,
  capability setgid,
  capability dac_override,
  capability dac_read_search,
  capability fowner,
  capability fsetid,
  capability setfcap,
  capability net_raw,
  capability net_bind_service,
  capability sys_ptrace,
  
  # Deny dangerous capabilities
  deny capability sys_admin,
  deny capability sys_module,
  deny capability sys_boot,
  deny capability mac_admin,
  deny capability mac_override,
  deny capability sys_time,
  
  # Filesystem
  / r,
  /** rwk,
  deny /proc/sys/kernel/** wk,
  
  # Network
  network inet,
  network inet6,
  
  # Ptrace (restrict to own processes only)
  ptrace read peer=docker-browser,
  
  # Signals
  signal (send, receive) peer=docker-browser,
  signal (send, receive) peer=unconfined peer_addr=kernel,
}
```

**Load profile:**
```bash
sudo apparmor_parser -r /etc/apparmor.d/docker-browser
sudo apparmor_status | grep docker-browser
```

### 2.4 Dockerfile Security Best Practices

```dockerfile
# Use minimal base image
FROM chromium:124-headless AS base

# Use nonroot user (don't run as root)
RUN groupadd -r browser && useradd -r -g browser browser

# Install only required packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy application code
COPY --chown=browser:browser . /app
WORKDIR /app

# Remove unnecessary SUID binaries
RUN find / -perm /6000 -type f -exec chmod a-s {} \; 2>/dev/null || true

# Switch to nonroot user
USER browser

# Run security scan before build (trivy)
# trivy image <image:tag>

ENTRYPOINT ["/app/start.sh"]
CMD ["--headless", "--no-sandbox"]
```

**Build & scan:**
```bash
docker build -t browsermcp-browser:latest .

# Security scanning
trivy image browsermcp-browser:latest
```

### 2.5 Container Runtime Flags

When launching browser containers:

```bash
docker run \
  --name browser-tenant-001 \
  --user browser:browser \
  --security-opt seccomp=/etc/docker/seccomp.json \
  --security-opt apparmor=docker-browser \
  --read-only \
  --tmpfs /tmp:noexec,nosuid,size=1g \
  --tmpfs /run:noexec,nosuid,size=512m \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --memory=2g \
  --cpus=1 \
  --pids-limit=100 \
  --network=tenant-001-network \
  --hostname=browser \
  --env NODE_ENV=production \
  --restart=on-failure:3 \
  --log-driver=json-file \
  --log-opt max-size=100m \
  --log-opt max-file=5 \
  browsermcp-browser:latest
```

**Explanation:**
- `--read-only`: Filesystem is read-only except /tmp and /run
- `--tmpfs`: Ephemeral storage with noexec,nosuid
- `--cap-drop=ALL`: Remove all Linux capabilities
- `--cap-add`: Re-add only required capabilities
- `--pids-limit`: Prevent fork bombs
- `--network`: Isolated network per tenant
- `--restart`: Auto-restart if crashed (3 attempts)

---

## 3. Network Security

### 3.1 Host-Level Firewall (iptables)

#### Container Bridge Isolation

```bash
# Enable IP forwarding (required for WireGuard)
echo "net.ipv4.ip_forward = 1" | sudo tee /etc/sysctl.d/99-forwarding.conf
sudo sysctl -p /etc/sysctl.d/99-forwarding.conf

# Create isolated bridge for browser containers (no host access)
sudo nano /etc/docker/daemon.json
# Add: "bridge": "none" and manage bridges manually

# Or use docker network with custom driver
docker network create \
  --driver bridge \
  --subnet=172.30.0.0/16 \
  --ip-range=172.30.1.0/24 \
  --gateway=172.30.1.1 \
  --opt "com.docker.network.bridge.name"="br-browser" \
  --opt "com.docker.network.bridge.enable_icc"="false" \
  browsermcp-net
```

#### iptables Rules for Tenant Isolation

```bash
#!/bin/bash
# /usr/local/bin/setup-tenant-network.sh

TENANT_ID=$1
TENANT_SUBNET=$2  # e.g., 172.30.1.0/24
WIREGUARD_IP=$3   # e.g., 10.1.1.2

if [ -z "$TENANT_ID" ] || [ -z "$TENANT_SUBNET" ] || [ -z "$WIREGUARD_IP" ]; then
  echo "Usage: $0 <tenant_id> <subnet> <wireguard_ip>"
  exit 1
fi

# Create chain for this tenant
sudo iptables -N TENANT_${TENANT_ID} 2>/dev/null || true

# Default: drop all traffic
sudo iptables -I TENANT_${TENANT_ID} -j DROP

# Allow WireGuard access (to user's private network)
sudo iptables -I TENANT_${TENANT_ID} -d $WIREGUARD_IP -j ACCEPT

# Allow container internal communication
sudo iptables -I TENANT_${TENANT_ID} -s $TENANT_SUBNET -d $TENANT_SUBNET -j ACCEPT

# Allow outbound DNS (for internal resolution only)
sudo iptables -I TENANT_${TENANT_ID} -d 127.0.0.11 -p udp --dport 53 -j ACCEPT

# Allow container to host (e.g., MCP server in main network namespace)
# Restrict to only MCP port
MAIN_NET_IP="172.17.0.1"  # Docker bridge gateway
sudo iptables -I TENANT_${TENANT_ID} -d $MAIN_NET_IP -p tcp --dport 3000 -j ACCEPT

# Apply to FORWARD chain (docker traffic)
sudo iptables -I FORWARD -s $TENANT_SUBNET -j TENANT_${TENANT_ID}
sudo iptables -I FORWARD -d $TENANT_SUBNET -j TENANT_${TENANT_ID}

# Persist (Ubuntu)
sudo netfilter-persistent save
```

**Use when creating tenant container:**
```bash
bash /usr/local/bin/setup-tenant-network.sh tenant-001 172.30.1.0/24 10.1.1.2
```

#### Verify Isolation

```bash
# From within tenant container:
docker exec browser-tenant-001 bash

# Inside container:
ping 172.30.2.0       # Should fail (different tenant)
ping 10.1.1.0         # Should work (WireGuard)
curl http://172.17.0.1:3000  # Should work (MCP server)
```

### 3.2 WireGuard Per-Tenant Setup

#### WireGuard Server Configuration

```bash
sudo apt install -y wireguard wireguard-tools

# Generate server keys
sudo wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key
sudo chmod 600 /etc/wireguard/server_private.key

# Create WireGuard interface
sudo nano /etc/wireguard/wg0.conf
```

```ini
[Interface]
Address = 10.1.0.1/24
ListenPort = 51820
PrivateKey = <contents_of_server_private.key>
# Post-up/down: routing and firewall
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE

# Per-tenant peer (example for Tenant A)
[Peer]
PublicKey = <tenant_a_public_key>
AllowedIPs = 10.1.1.0/25
PersistentKeepalive = 25
```

**Bring up WireGuard:**
```bash
sudo wg-quick up wg0
sudo systemctl enable wg-quick@wg0

# Verify
sudo wg show
```

#### Generate Per-Tenant Credentials

```bash
#!/bin/bash
# /usr/local/bin/gen-wireguard-creds.sh

TENANT_ID=$1
OUTPUT_DIR="/etc/wireguard/tenants/${TENANT_ID}"

mkdir -p $OUTPUT_DIR
chmod 700 $OUTPUT_DIR

# Generate tenant keys
wg genkey > ${OUTPUT_DIR}/private.key
cat ${OUTPUT_DIR}/private.key | wg pubkey > ${OUTPUT_DIR}/public.key

# Assign IP from pool
LAST_IP=$(grep -oP '10\.1\.\d+\.\d+' /etc/wireguard/wg0.conf | sort -V | tail -1 | cut -d. -f4)
NEXT_IP=$((LAST_IP + 1))
TENANT_IP="10.1.${NEXT_IP%256}.$((NEXT_IP % 256))"

# Generate client config
cat > ${OUTPUT_DIR}/client.conf << EOF
[Interface]
PrivateKey = $(cat ${OUTPUT_DIR}/private.key)
Address = ${TENANT_IP}/32
DNS = 10.1.0.1

[Peer]
PublicKey = $(cat /etc/wireguard/server_public.key)
AllowedIPs = 0.0.0.0/0
Endpoint = <server_public_ip>:51820
PersistentKeepalive = 25
EOF

chmod 600 ${OUTPUT_DIR}/client.conf

echo "✓ Generated WireGuard credentials for $TENANT_ID"
echo "  IP: $TENANT_IP"
echo "  Config: ${OUTPUT_DIR}/client.conf"
```

**Usage:**
```bash
bash /usr/local/bin/gen-wireguard-creds.sh tenant-001
```

#### Key Rotation

```bash
#!/bin/bash
# /usr/local/bin/rotate-wireguard-keys.sh

TENANT_ID=$1
OUTPUT_DIR="/etc/wireguard/tenants/${TENANT_ID}"

# Backup old keys
cp ${OUTPUT_DIR}/private.key ${OUTPUT_DIR}/private.key.bak-$(date +%s)

# Generate new keys
wg genkey > ${OUTPUT_DIR}/private.key.new
cat ${OUTPUT_DIR}/private.key.new | wg pubkey > ${OUTPUT_DIR}/public.key.new

# Update wg0.conf with new public key (manually or via script)
# Get new public key
NEW_PUB=$(cat ${OUTPUT_DIR}/public.key.new)
echo "Update /etc/wireguard/wg0.conf peer for $TENANT_ID with PublicKey = $NEW_PUB"

# After updating wg0.conf:
sudo wg set wg0 peer $(cat ${OUTPUT_DIR}/public.key.new) allowed-ips 10.1.x.x/32

# Notify tenant to update their config
cat ${OUTPUT_DIR}/client.conf  # Regenerate with new private key

# Verify connection established with new key before deleting old
sleep 30
wg show | grep $TENANT_ID

# Commit new key
mv ${OUTPUT_DIR}/private.key.new ${OUTPUT_DIR}/private.key
mv ${OUTPUT_DIR}/public.key.new ${OUTPUT_DIR}/public.key
```

---

## 4. Auth & Secrets Management

### 4.1 JWT Signing Key Management

#### Key Generation & Storage

```bash
# Generate ECDSA signing key (better than RSA for JWT)
openssl ecparam -genkey -name prime256v1 -out /etc/browsermcp/jwt_signing_key.pem
openssl ec -in /etc/browsermcp/jwt_signing_key.pem -pubout -out /etc/browsermcp/jwt_public_key.pem

# Restrict permissions
sudo chmod 600 /etc/browsermcp/jwt_signing_key.pem
sudo chmod 644 /etc/browsermcp/jwt_public_key.pem
sudo chown browsermcp:browsermcp /etc/browsermcp/jwt_*.pem

# Verify
openssl ec -in /etc/browsermcp/jwt_signing_key.pem -text -noout
```

#### Load into Application (via Vault or Environment)

**Option 1: HashiCorp Vault (Recommended for production)**

```bash
# Install Vault agent
wget https://releases.hashicorp.com/vault/1.15.0/vault_1.15.0_linux_amd64.zip
unzip vault_1.15.0_linux_amd64.zip
sudo mv vault /usr/local/bin/

# Vault agent config (/etc/vault/agent.hcl)
vault {
  address = "https://vault.company.internal:8200"
}

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path = "/etc/vault/role_id"
      secret_id_file_path = "/etc/vault/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }
}

cache {
  use_auto_auth_token = true
}

listener "unix" {
  address = "/var/run/vault/agent.sock"
  tls_disable = true
}

listener "tcp" {
  address = "127.0.0.1:8200"
  tls_disable = true
}
```

**Option 2: Environment Variables (Development)**

```bash
# Load into .env (DO NOT commit to git)
export JWT_SIGNING_KEY="$(cat /etc/browsermcp/jwt_signing_key.pem)"
export JWT_PUBLIC_KEY="$(cat /etc/browsermcp/jwt_public_key.pem)"

# Application reads:
const signingKey = process.env.JWT_SIGNING_KEY;
const publicKey = process.env.JWT_PUBLIC_KEY;
const token = jwt.sign(payload, signingKey, { algorithm: 'ES256' });
```

#### JWT Token Generation (Application Code)

```javascript
// Example: Node.js + jsonwebtoken library
const jwt = require('jsonwebtoken');
const fs = require('fs');

const signingKey = fs.readFileSync('/etc/browsermcp/jwt_signing_key.pem', 'utf8');
const publicKey = fs.readFileSync('/etc/browsermcp/jwt_public_key.pem', 'utf8');

// Generate token
const token = jwt.sign(
  {
    sub: user.id,           // User ID
    tenant_id: user.tenant, // Tenant ID
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,  // 1 hour expiry
  },
  signingKey,
  { algorithm: 'ES256' }
);

// Verify token
jwt.verify(token, publicKey, { algorithms: ['ES256'] }, (err, decoded) => {
  if (err) {
    console.error('Invalid token:', err.message);
    return;
  }
  console.log('Valid token for tenant:', decoded.tenant_id);
});
```

### 4.2 API Key Hashing

```javascript
// Generate API key (for service-to-service auth)
const crypto = require('crypto');

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Hash API key before storing in database
const apiKey = generateApiKey();
const hashedKey = crypto
  .createHash('sha256')
  .update(apiKey)
  .digest('hex');

// Store in DB: { api_key_hash, created_at, tenant_id }
db.insert('api_keys', {
  api_key_hash: hashedKey,
  tenant_id: tenantId,
  created_at: new Date(),
});

// When validating incoming API key:
const incomingKeyHash = crypto.createHash('sha256').update(incomingKey).digest('hex');
const storedKey = db.query('SELECT * FROM api_keys WHERE api_key_hash = ?', [incomingKeyHash]);
```

### 4.3 Secrets Storage

#### Vault Integration (Production)

```bash
# Login to Vault
vault login -path=auth/approle -method=approle role_id=<role_id> secret_id=<secret_id>

# Store secret
vault kv put secret/browsermcp/prod/jwt \
  signing_key=@/etc/browsermcp/jwt_signing_key.pem \
  public_key=@/etc/browsermcp/jwt_public_key.pem

# Retrieve secret
vault kv get -field=signing_key secret/browsermcp/prod/jwt > /tmp/jwt_key.pem

# Rotate secret (with automatic application restart)
vault kv put secret/browsermcp/prod/jwt signing_key=@/new/key.pem

# Watch for secret changes (trigger reload)
vault watch secret/browsermcp/prod/jwt
```

#### Environment Variables (Development Only)

```bash
# .env.local (never commit!)
JWT_SIGNING_KEY="-----BEGIN PRIVATE KEY-----\n..."
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."
WIREGUARD_PRIVATE_KEY="..."
TLS_CERT="..."
TLS_KEY="..."
```

### 4.4 TLS Certificate Management

#### Auto-Renewal with cert-manager (Kubernetes)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: browsermcp-tls
spec:
  secretName: browsermcp-tls
  commonName: mcp.company.example
  dnsNames:
    - mcp.company.example
    - "*.mcp.company.example"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@company.example
    privateKeySecretRef:
      name: letsencrypt-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

#### Manual Let's Encrypt (Docker Compose)

```bash
# Install certbot
sudo apt install -y certbot python3-certbot-nginx

# Generate certificate
sudo certbot certonly --standalone \
  -d mcp.company.example \
  --email ops@company.example \
  --agree-tos

# Certificate location: /etc/letsencrypt/live/mcp.company.example/

# Set up auto-renewal cron job
echo "0 3 * * * certbot renew --quiet && systemctl reload docker" | sudo crontab -
```

#### Use Certificate in Node.js

```javascript
const https = require('https');
const fs = require('fs');
const express = require('express');

const app = express();

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/mcp.company.example/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/mcp.company.example/fullchain.pem'),
};

https.createServer(options, app).listen(443, () => {
  console.log('MCP Server listening on HTTPS port 443');
});
```

---

## 5. Multi-Tenant Isolation Checklist

### 5.1 Pre-Deployment Verification

**Before deploying to production, verify:**

- [ ] Each tenant container has unique network namespace
- [ ] iptables rules prevent inter-tenant traffic (test with ping/curl)
- [ ] WireGuard peer keys are unique per tenant
- [ ] Session store keys include tenant_id (no cross-tenant session access)
- [ ] Bearer tokens contain tenant_id claim; server validates on every request
- [ ] Docker images run as nonroot user
- [ ] Seccomp profile blocks dangerous syscalls
- [ ] AppArmor profile is loaded and enforced
- [ ] Read-only filesystem (except /tmp, /run)
- [ ] Resource limits enforced (memory, CPU, pids)

### 5.2 Isolation Test Harness

```bash
#!/bin/bash
# /usr/local/bin/test-tenant-isolation.sh

echo "=== Testing Tenant Isolation ==="

# Deploy two test containers
docker run -d --name test-tenant-a \
  --network tenant-a-net \
  --security-opt seccomp=/etc/docker/seccomp.json \
  alpine sleep 3600

docker run -d --name test-tenant-b \
  --network tenant-b-net \
  --security-opt seccomp=/etc/docker/seccomp.json \
  alpine sleep 3600

echo "✓ Containers deployed"

# Test 1: Cannot access other tenant's container
echo -n "Test 1 (cross-tenant isolation): "
if docker exec test-tenant-a ping -c 1 test-tenant-b >/dev/null 2>&1; then
  echo "FAIL - Tenant A can ping Tenant B!"
  exit 1
else
  echo "PASS"
fi

# Test 2: Cannot access host network
echo -n "Test 2 (host isolation): "
if docker exec test-tenant-a ping -c 1 172.17.0.1 >/dev/null 2>&1; then
  echo "FAIL - Container can ping Docker bridge!"
  exit 1
else
  echo "PASS"
fi

# Test 3: Cannot execute dangerous syscalls
echo -n "Test 3 (seccomp enforcement): "
if docker exec test-tenant-a mount -t tmpfs none /tmp/test >/dev/null 2>&1; then
  echo "FAIL - mount() syscall allowed!"
  exit 1
else
  echo "PASS"
fi

# Test 4: Cannot write to read-only filesystem
echo -n "Test 4 (read-only filesystem): "
if docker exec test-tenant-a touch /root/test >/dev/null 2>&1; then
  echo "FAIL - Can write to read-only filesystem!"
  exit 1
else
  echo "PASS"
fi

# Test 5: Resource limits enforced
echo -n "Test 5 (resource limits): "
MEMORY_LIMIT=$(docker inspect test-tenant-a | grep -oP '"Memory": \K\d+')
if [ "$MEMORY_LIMIT" -eq 0 ]; then
  echo "FAIL - No memory limit set!"
  exit 1
else
  echo "PASS ($MEMORY_LIMIT bytes)"
fi

# Cleanup
docker rm -f test-tenant-a test-tenant-b

echo ""
echo "✅ All isolation tests passed!"
```

**Run test:**
```bash
bash /usr/local/bin/test-tenant-isolation.sh
```

### 5.3 Session Isolation Verification

```bash
#!/bin/bash
# Test that session data is isolated per tenant

TENANT_A_TOKEN="eyJhbGc..."  # Valid JWT for tenant A
TENANT_B_TOKEN="eyJhbGc..."  # Valid JWT for tenant B
SERVER="https://mcp.company.example"

# Create session for Tenant A
SESSION_A=$(curl -s -X POST $SERVER/mcp \
  -H "Authorization: Bearer $TENANT_A_TOKEN" \
  | grep -oP '"session_id": "\K[^"]+')

echo "Tenant A session: $SESSION_A"

# Create session for Tenant B
SESSION_B=$(curl -s -X POST $SERVER/mcp \
  -H "Authorization: Bearer $TENANT_B_TOKEN" \
  | grep -oP '"session_id": "\K[^"]+')

echo "Tenant B session: $SESSION_B"

# Try to use Tenant A's session with Tenant B's token (should fail)
echo -n "Cross-tenant session access: "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST $SERVER/mcp/navigate \
  -H "Authorization: Bearer $TENANT_B_TOKEN" \
  -H "Mcp-Session-Id: $SESSION_A" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}')

if [ "$HTTP_CODE" == "403" ] || [ "$HTTP_CODE" == "401" ]; then
  echo "PASS (returned $HTTP_CODE)"
else
  echo "FAIL (returned $HTTP_CODE, expected 403/401)"
fi
```

---

## 6. Incident Response Procedures

### 6.1 Browser Sandbox Escape

**Detection:**

```bash
# Monitor system calls for suspicious patterns
sudo auditctl -w /bin -p wa -k suspicious_bin_access
sudo auditctl -w /sbin -p wa -k suspicious_sbin_access
sudo tail -f /var/log/audit/audit.log | grep suspicious

# Check for unexpected process escaping container
docker stats --no-stream | grep <container_id>
docker inspect <container_id> | grep -i "pid"
```

**Immediate Response:**

1. **Kill the container:**
   ```bash
   docker rm -f <container_id>
   ```

2. **Isolate the host:**
   ```bash
   # Block any outbound traffic from compromised container
   sudo ufw deny out to any from 10.1.x.x
   
   # Notify security team
   ```

3. **Preserve evidence:**
   ```bash
   # Backup container filesystem
   docker export <container_id> > /secure/backup/container-forensics-$(date +%s).tar
   
   # Save logs
   docker logs <container_id> > /secure/backup/container-logs.txt
   ```

4. **Investigation:**
   ```bash
   # Check for compromised system calls in kernel logs
   dmesg | tail -100
   
   # Audit trail
   grep <container_id> /var/log/audit/audit.log
   ```

### 6.2 WireGuard Key Compromise

**Detection:**

```bash
# Monitor for unexpected connections
sudo tcpdump -i wg0 -n host <user_ip>

# Check peer connection attempts
wg show wg0
```

**Immediate Response:**

1. **Revoke compromised peer key:**
   ```bash
   sudo wg set wg0 peer <public_key_hex> remove
   sudo wg-quick save wg0
   ```

2. **Rotate tenant keys:**
   ```bash
   bash /usr/local/bin/rotate-wireguard-keys.sh <tenant_id>
   
   # Notify tenant to update VPN config
   ```

3. **Audit access logs:**
   ```bash
   grep "<public_key>" /var/log/wg-access.log
   ```

4. **Monitor for lateral movement:**
   ```bash
   # Check if attacker accessed other tenants' networks
   sudo ip netns list
   sudo ip netns exec ns-tenant-b tcpdump -n src <user_ip>
   ```

### 6.3 DDoS Attack

**Detection:**

```bash
# Monitor packet rate
watch -n 1 'ifstat -i eth0 1 1'

# Check UFW logs for packet drops
grep "DPT" /var/log/ufw.log | sort | uniq -c | sort -rn | head

# Identify attack source
tcpdump -i eth0 -n 'tcp[tcpflags] & tcp-syn != 0' | grep -oP 'src \K[^ ]+' | sort | uniq -c | sort -rn
```

**Response:**

1. **Rate limiting (iptables):**
   ```bash
   # Limit SYN packets per second
   sudo iptables -I INPUT -p tcp --dport 443 -m limit --limit 10/second -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j DROP
   
   # Limit HTTP requests per IP
   sudo iptables -I INPUT -p tcp --dport 80 -m limit --limit 100/minute -j ACCEPT
   ```

2. **Contact ISP/CDN:**
   ```bash
   # If behind Cloudflare/Akamai, enable DDoS protection
   # CLI example:
   curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone_id>/firewall/ua_rules" \
     -H "X-Auth-Email: $EMAIL" \
     -H "X-Auth-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     --data '[{"action":"block","description":"DDoS mitigation"}]'
   ```

3. **Scale infrastructure:**
   ```bash
   # Failover to backup server
   # Update DNS to point to backup
   # Scale container instances
   docker-compose up -d --scale browser=20
   ```

### 6.4 Credential Leak

**Detection:**

```bash
# Monitor for suspicious token usage
grep "403\|401" /var/log/browsermcp/*.log | wc -l

# Check for token appearing in logs (it shouldn't)
grep -r "Authorization:" /var/log/browsermcp/
```

**Response:**

1. **Revoke leaked tokens:**
   ```bash
   # Add to Redis blacklist
   redis-cli set "revoked_token:<token_hash>" "true" EX 3600
   
   # Application checks before processing:
   # if (redis.get(`revoked_token:${tokenHash}`)) reject();
   ```

2. **Audit token usage:**
   ```bash
   # Query logs for all uses of leaked token
   grep "<token>" /var/log/browsermcp/access.log
   
   # Check what actions were taken
   grep "<token>" /var/log/browsermcp/action.log
   ```

3. **Force re-authentication:**
   ```bash
   # Invalidate all tokens for affected user
   redis-cli del "session:*:user_id:<user_id>"
   
   # Notify user to re-authenticate
   ```

4. **Update secrets rotation policy:**
   ```bash
   # Rotate all signing keys (if compromise is severe)
   bash /usr/local/bin/rotate-jwt-keys.sh
   ```

---

## 7. Compliance Roadmap

### 7.1 SOC2 Type II Compliance

**Timeline:** 6-12 months audit period

**Requirements & Implementation:**

| Requirement | Implementation | Owner | Status |
|---|---|---|---|
| **CC6.1: Information Confidentiality** | AES-256 encryption at rest + TLS 1.3 in transit | Infra | ✅ |
| **CC6.2: Cryptographic Key Management** | Vault integration for key rotation | SecOps | ✅ |
| **CC7.1: User Authentication** | OAuth 2.0 + MFA for admin accounts | SecOps | ✅ |
| **CC7.2: User Access Rights** | RBAC with audit logging | AppDev | 🟡 |
| **CC8.1: Authorized User Access** | Session timeout + multi-factor auth | Infra | ✅ |
| **CC9.1: Audit Logging** | auditd + centralized SIEM | SecOps | 🟡 |
| **CC9.2: System Monitoring** | Prometheus + Grafana with alerts | DevOps | 🟡 |
| **A1.1: Risk Management** | Security policy document | SecOps | 🟡 |
| **A1.2: Risk Assessment** | Annual security assessment | CISO | ❌ |

**Audit Preparation Checklist:**

- [ ] Document all data flows (PII, payment data)
- [ ] Maintain change log for all infrastructure changes (git history)
- [ ] Implement segregation of duties (dev ≠ prod access)
- [ ] Establish incident response procedures (documented in this spec)
- [ ] Conduct security awareness training for all staff
- [ ] Perform annual penetration test
- [ ] Maintain vulnerability scanning reports (trivy, snyk)
- [ ] Document all third-party access (contractors, vendors)
- [ ] Maintain backup/restore testing records
- [ ] Evidence of access controls enforcement

### 7.2 GDPR Compliance

**Key Obligations:**

1. **Data Minimization**
   - [ ] Only collect/process necessary user data
   - [ ] Define data retention policy (7, 30, 90 days per type)
   - [ ] Implement automatic data deletion after retention period

   ```bash
   # Cron job for data expiration
   0 3 * * * /usr/local/bin/expire-user-data.sh
   ```

2. **User Rights**
   - [ ] Implement "Right to Access" (export user data)
   - [ ] Implement "Right to Deletion" (delete user data)
   - [ ] Implement "Right to Portability" (export in standard format)

   ```javascript
   // Example: GDPR data export endpoint
   app.post('/api/gdpr/export', authenticateUser, async (req, res) => {
     const userId = req.user.id;
     const data = {
       profile: await db.getUserProfile(userId),
       sessions: await db.getUserSessions(userId),
       activities: await db.getUserActivities(userId),
     };
     res.json(data);
   });
   ```

3. **Data Processing Agreements**
   - [ ] Sign DPA with cloud providers (Hetzner)
   - [ ] Sign DPA with sub-processors (Vault, monitoring tools)

4. **Privacy Policy**
   - [ ] Clearly state data collection practices
   - [ ] Obtain explicit consent for data processing
   - [ ] Provide transparent opt-out mechanisms

5. **Data Breach Notification**
   - [ ] Establish 72-hour notification process
   - [ ] Document breach handling procedure

   ```bash
   #!/bin/bash
   # Breach notification checklist
   echo "GDPR Breach Notification Checklist"
   echo "Date: $(date)"
   echo "[ ] Assess severity and impact"
   echo "[ ] Notify affected users within 72 hours"
   echo "[ ] Notify supervisory authority"
   echo "[ ] Document breach in breach register"
   echo "[ ] Conduct forensic analysis"
   echo "[ ] Implement remediation measures"
   ```

### 7.3 Data Retention Policy

```
Data Type              | Retention | Deletion | Reason
-----------------------|-----------|----------|--------
User Profile          | 90 days   | Auto     | GDPR Right to Deletion
Session Logs          | 7 days    | Auto     | Debugging
API Access Logs       | 30 days   | Auto     | Security audit
Browser Activity      | 1 day     | Auto     | Disk space
Audit Logs (security) | 1 year    | Manual   | Compliance
Incident Reports      | 3 years   | Manual   | Legal hold
```

**Implementation:**

```javascript
// Cron: Expire user data daily
schedule.scheduleJob('0 3 * * *', async () => {
  const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  
  // Delete old session logs
  await db.sessionLogs.deleteMany({ createdAt: { $lt: cutoffDate } });
  
  // Delete old user profiles (unless opted in)
  const orphanedUsers = await db.users.find({
    createdAt: { $lt: cutoffDate },
    lastLogin: { $lt: cutoffDate },
  });
  
  for (const user of orphanedUsers) {
    await deleteUserData(user.id);
  }
});
```

---

## 8. Operational Runbooks

### 8.1 Adding a New Server (Scale Out)

**Prerequisites:**
- Hetzner account access
- Admin SSH key
- DNS credentials

**Steps:**

```bash
#!/bin/bash
# /usr/local/bin/provision-new-server.sh

NEW_SERVER_IP=$1
NEW_SERVER_HOSTNAME=$2

if [ -z "$NEW_SERVER_IP" ] || [ -z "$NEW_SERVER_HOSTNAME" ]; then
  echo "Usage: $0 <ip> <hostname>"
  exit 1
fi

echo "📦 Provisioning new server: $NEW_SERVER_HOSTNAME"

# Step 1: Initial SSH connection & hostname setup
echo "1️⃣  Setting hostname..."
ssh -i ~/.ssh/id_remotebrowser_prod root@$NEW_SERVER_IP \
  "hostnamectl set-hostname $NEW_SERVER_HOSTNAME && \
   echo '$NEW_SERVER_IP $NEW_SERVER_HOSTNAME' >> /etc/hosts"

# Step 2: Run system hardening
echo "2️⃣  Running security hardening..."
ssh -i ~/.ssh/id_remotebrowser_prod root@$NEW_SERVER_IP \
  "apt update && apt upgrade -y && \
   apt install -y ufw fail2ban auditd wireguard docker.io docker-compose-plugin"

# Copy hardening configs
scp -i ~/.ssh/id_remotebrowser_prod \
  /etc/ssh/sshd_config root@$NEW_SERVER_IP:/etc/ssh/sshd_config.new
ssh -i ~/.ssh/id_remotebrowser_prod root@$NEW_SERVER_IP \
  "mv /etc/ssh/sshd_config.new /etc/ssh/sshd_config && systemctl reload ssh"

# Step 3: Configure Docker
echo "3️⃣  Configuring Docker..."
scp -i ~/.ssh/id_remotebrowser_prod \
  /etc/docker/daemon.json root@$NEW_SERVER_IP:/etc/docker/daemon.json
ssh -i ~/.ssh/id_remotebrowser_prod root@$NEW_SERVER_IP \
  "systemctl restart docker"

# Step 4: Deploy WireGuard
echo "4️⃣  Setting up WireGuard..."
ssh -i ~/.ssh/id_remotebrowser_prod root@$NEW_SERVER_IP \
  "wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key"

# Step 5: Register in load balancer
echo "5️⃣  Registering in load balancer..."
# Example: Add to nginx upstream
curl -X POST "https://loadbalancer.internal/api/upstream/add" \
  -H "Authorization: Bearer $LB_TOKEN" \
  -d "{\"address\": \"$NEW_SERVER_IP:443\"}"

# Step 6: Health check
echo "6️⃣  Running health checks..."
sleep 10
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://$NEW_SERVER_IP/health)
if [ "$HTTP_CODE" == "200" ]; then
  echo "✅ Server $NEW_SERVER_HOSTNAME is healthy!"
else
  echo "❌ Server returned HTTP $HTTP_CODE"
  exit 1
fi

echo "✅ Server provisioning complete!"
```

**Usage:**
```bash
bash /usr/local/bin/provision-new-server.sh 203.0.113.10 browsermcp-prod-2
```

### 8.2 Rotating Secrets (JWT Keys, WireGuard, etc.)

**Planning:**
- Schedule during low-traffic window (3 AM UTC)
- Prepare rollback plan
- Notify users 24 hours in advance

**Steps:**

```bash
#!/bin/bash
# /usr/local/bin/rotate-secrets.sh

echo "🔄 Starting secret rotation..."

# Step 1: Generate new JWT keys
echo "1️⃣  Generating new JWT keys..."
openssl ecparam -genkey -name prime256v1 -out /etc/browsermcp/jwt_signing_key.pem.new
openssl ec -in /etc/browsermcp/jwt_signing_key.pem.new -pubout -out /etc/browsermcp/jwt_public_key.pem.new

# Step 2: Store new keys in Vault
echo "2️⃣  Storing new keys in Vault..."
vault kv put secret/browsermcp/prod/jwt \
  signing_key=@/etc/browsermcp/jwt_signing_key.pem.new \
  public_key=@/etc/browsermcp/jwt_public_key.pem.new

# Step 3: Update applications (blue-green deployment)
echo "3️⃣  Deploying new version with rotated keys..."
kubectl set env deployment/browsermcp-server \
  JWT_VERSION="v2" --record

# Step 4: Monitor for errors
echo "4️⃣  Monitoring application health..."
for i in {1..30}; do
  ERRORS=$(kubectl logs -l app=browsermcp --tail=100 | grep -i "JWT.*error" | wc -l)
  if [ $ERRORS -gt 10 ]; then
    echo "❌ Too many JWT errors! Rolling back..."
    kubectl rollout undo deployment/browsermcp-server
    exit 1
  fi
  sleep 10
done

# Step 5: Validate tokens still work
echo "5️⃣  Validating token generation..."
TEST_TOKEN=$(curl -s -X POST https://mcp.company.example/auth/token \
  -d 'grant_type=client_credentials' | grep -oP '"access_token": "\K[^"]+')

if [ -z "$TEST_TOKEN" ]; then
  echo "❌ Token generation failed!"
  kubectl rollout undo deployment/browsermcp-server
  exit 1
fi

# Step 6: Old tokens still work (during grace period)
echo "6️⃣  Verifying old tokens still valid..."
# Set grace period to 24 hours
redis-cli EVAL "
  local key = KEYS[1]
  redis.call('EXPIRE', key, 86400)
  return 'OK'
" 1 "old_jwt_key_version"

# Step 7: Archive old keys
echo "7️⃣  Archiving old keys..."
mv /etc/browsermcp/jwt_signing_key.pem /etc/browsermcp/jwt_signing_key.pem.old-$(date +%s)
mv /etc/browsermcp/jwt_public_key.pem /etc/browsermcp/jwt_public_key.pem.old-$(date +%s)
mv /etc/browsermcp/jwt_signing_key.pem.new /etc/browsermcp/jwt_signing_key.pem
mv /etc/browsermcp/jwt_public_key.pem.new /etc/browsermcp/jwt_public_key.pem

echo "✅ Secret rotation complete!"
```

### 8.3 Investigating a Stuck Session

**Symptoms:**
- User unable to disconnect
- Browser process still running despite session timeout
- WebSocket not closing

**Diagnosis:**

```bash
#!/bin/bash
# /usr/local/bin/investigate-stuck-session.sh

SESSION_ID=$1

if [ -z "$SESSION_ID" ]; then
  echo "Usage: $0 <session_id>"
  exit 1
fi

echo "🔍 Investigating session: $SESSION_ID"

# Step 1: Check session in Redis
echo "1️⃣  Session state in Redis:"
redis-cli HGETALL "session:$SESSION_ID"

# Step 2: Find associated container
echo "2️⃣  Finding container..."
CONTAINER_ID=$(redis-cli HGET "session:$SESSION_ID" "container_id")
echo "Container: $CONTAINER_ID"

# Step 3: Check container status
echo "3️⃣  Container status:"
docker inspect $CONTAINER_ID | grep -E "Status|Pid"

# Step 4: Check process state
echo "4️⃣  Browser process details:"
docker top $CONTAINER_ID

# Step 5: Check network connections
echo "5️⃣  Network connections:"
docker exec $CONTAINER_ID netstat -tlnp | grep -i listen

# Step 6: Check logs for errors
echo "6️⃣  Recent error logs:"
docker logs --tail 50 $CONTAINER_ID | grep -i error

# Step 7: Force cleanup if needed
read -p "Force kill container? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "7️⃣  Killing container..."
  docker rm -f $CONTAINER_ID
  
  # Clean up session
  redis-cli DEL "session:$SESSION_ID"
  
  echo "✅ Session cleaned up"
else
  echo "⏸️  Leaving container running"
fi
```

### 8.4 Emergency Shutdown

**Use case:** Suspected compromise, critical vulnerability, legal hold

**Steps:**

```bash
#!/bin/bash
# /usr/local/bin/emergency-shutdown.sh

echo "🚨 EMERGENCY SHUTDOWN INITIATED"
echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee /secure/logs/emergency-shutdown.log

# Step 1: Stop all containers (preserve for forensics)
echo "Stopping all containers..."
docker ps -q | xargs docker stop

# Step 2: Disable network access
echo "Disabling network..."
sudo ufw deny in
sudo ufw deny out

# Step 3: Preserve evidence
echo "Collecting forensic evidence..."
tar czf /secure/forensics/system-$(date +%s).tar.gz \
  /var/log \
  /var/lib/docker \
  /etc \
  /proc/sys

# Step 4: Notify stakeholders
echo "Sending notifications..."
echo "EMERGENCY SHUTDOWN: Check /secure/logs/emergency-shutdown.log" | \
  mail -s "INCIDENT: Remote Browser Service Shutdown" security@company.example

# Step 5: Lock system
echo "System locked. Only forensic analysis mode available."
sudo systemctl isolate rescue.target
```

---

## Appendix: Quick Reference Checklist

### Daily (Automated)

- [ ] Automatic security updates applied
- [ ] Logs rotated and compressed
- [ ] Database backups created
- [ ] Session data purged (expired)
- [ ] Certificate renewal checked

### Weekly

- [ ] Review failed login attempts (fail2ban logs)
- [ ] Check disk space usage
- [ ] Verify WireGuard peer connectivity
- [ ] Audit API key usage
- [ ] Test backup restoration

### Monthly

- [ ] Review container image vulnerabilities (trivy)
- [ ] Audit user access logs
- [ ] Validate multi-tenant isolation tests
- [ ] Update firewall rules (if needed)
- [ ] Review incident logs

### Quarterly

- [ ] Security awareness training
- [ ] Penetration test or vulnerability scan
- [ ] Rotate API keys
- [ ] Review and update incident response procedures
- [ ] Disaster recovery drill

### Annually

- [ ] SOC2 Type II audit
- [ ] GDPR compliance review
- [ ] Full system penetration test
- [ ] Update security policies
- [ ] Rotate SSH keys for all admins

---

**Document Status:** Operational Playbook v1.0  
**Last Updated:** 2026-04-13  
**Maintainer:** Security & DevOps Team  
**Next Review:** 2026-07-13
