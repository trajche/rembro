# Remote Browser MCP: Infrastructure Architecture Research

## Executive Summary

This document synthesizes research on building a scalable, secure hosted browser MCP service on Hetzner (Ubuntu 24+) that enables remote browser instances to stream via VNC/WebRTC and connect to users' private networks via WireGuard.

---

## 1. Container/Isolation Strategies

### Overview of Technologies

Three primary isolation technologies exist for modern containerization:

#### **Docker (Standard Containers)**
- **Isolation**: Uses Linux namespaces (PID, IPC, UTS, network, user) with shared kernel
- **Startup Time**: ~500ms-2s typical cold start
- **Memory Overhead**: ~20-50MB per container minimal overhead beyond base image
- **Best For**: General-purpose containerized applications, ease of deployment
- **Limitations**: Kernel-level vulnerability access, weaker isolation than VMs
- **Headless Chrome Compatibility**: Excellent, widely used, extensive tooling (Puppeteer, Playwright)

#### **Kata Containers**
- **Isolation**: Lightweight VMs using hypervisors (QEMU, Cloud-Hypervisor, Firecracker)
- **Startup Time**: 150-300ms per instance (kernel boot + container runtime)
- **Memory Overhead**: ~100-200MB per instance (full VM kernel)
- **Best For**: Multi-tenant scenarios where workload isolation is critical
- **Security**: Hardware-assisted virtualization provides strong isolation
- **Trade-off**: Higher memory/startup cost vs. Docker, but better isolation
- **Headless Chrome**: Viable but requires sufficient memory budget

#### **Firecracker MicroVMs**
- **Isolation**: Purpose-built hypervisor for serverless functions, highly optimized
- **Startup Time**: 100-200ms cold start (optimized via pre-warming)
- **Memory Overhead**: ~20-50MB base, minimal compared to full VMs
- **Best For**: Serverless, function-as-a-service, short-lived workloads
- **Trade-off**: Purpose-built for AWS Lambda patterns; less common in self-hosted scenarios
- **Headless Chrome**: Possible but not typical use case; overhead reduction valuable

#### **systemd-nspawn**
- **Isolation**: OS-level container manager using Linux namespaces
- **Startup Time**: <100ms, fastest among isolation methods
- **Memory Overhead**: Minimal, shares kernel
- **Best For**: Lightweight workloads, system containers, integration with systemd infrastructure
- **Trade-off**: Less feature-rich than Docker; lower isolation than Kata/Firecracker
- **Headless Chrome**: Viable for single-machine deployments; not standard for production
- **Network Isolation**: Supports private networking mode suitable for isolated browsers

#### **gVisor (User-Space Kernel)**
- **Isolation**: Intercepts syscalls, provides sandboxing without VMs
- **Startup Time**: 50-100ms, very fast
- **Memory Overhead**: Moderate per-instance overhead for gVisor runtime
- **Best For**: Untrusted workload execution, research/academic use
- **Trade-off**: Compatibility issues with some syscalls; maintained by Google but niche adoption

### Recommendation for Headless Chrome

**Docker (primary) + optional Kata Containers (security-focused):**

1. **Standard Deployment**: Docker with resource limits (cgroups) provides:
   - Fast deployment (proven headless Chrome tooling)
   - Memory efficiency for scale: 300-500MB per Chrome instance typical
   - CPU: ~0.5-1 CPU core per active instance during page load
   - Industry standard with extensive Chrome-specific optimization guides

2. **Security Isolation Variant**: Kata Containers for:
   - Multi-tenant scenarios where workload escape is concern
   - Premium tier services requiring stricter isolation
   - Cost trade-off: ~200MB additional per instance for strong VM isolation

### Container Density Calculations (Hetzner AX41-NVMe)

**Hardware**: 64GB RAM, 6-core Ryzen 5, NVMe storage

**Scenario A (Docker, moderate isolation)**:
- 300MB base + 150MB average per Chrome instance = ~450MB per instance
- 64GB / 450MB ≈ **140+ concurrent instances** (not recommended, system overhead)
- **Realistic production**: 30-50 concurrent instances with healthy headroom
- CPU limit: 6 cores / 0.5 core per instance ≈ 12 concurrent loads (bottleneck)
- **Constraint**: CPU before RAM on 6-core server for active workloads

**Scenario B (Kata Containers, strong isolation)**:
- 300MB base + 200MB VM kernel + 150MB Chrome = ~650MB per instance
- 64GB / 650MB ≈ **95 instances** theoretical
- **Realistic production**: 15-25 instances with overhead
- Same CPU constraints apply
- **Best for**: Lower concurrency, higher reliability SLAs

**Practical Scaling Strategy**:
- Single AX41 suitable for 20-40 concurrent users in typical workloads
- Multi-server cluster (3-5 AX41 nodes) for 100+ concurrent users
- Load balancing via Kubernetes/Nomad across nodes
- Memory is not bottleneck for modest concurrency; CPU is primary constraint

---

## 2. VNC/noVNC Streaming & Alternatives

### Traditional Approach: VNC + noVNC

#### **VNC (Virtual Network Computing)**
- **Protocol**: RFB (Remote Framebuffer)
- **Streaming**: Inefficient frame-based compression, high bandwidth
- **Latency**: 50-200ms typical (varies by compression/quality)
- **Client**: Binary desktop apps or noVNC web client
- **Pros**: Universal, well-established, works with X11 + Xvfb/Xdummy
- **Cons**: Bandwidth-intensive, lag noticeable, image quality trade-offs

#### **noVNC (Web-based VNC Client)**
- **Implementation**: JavaScript VNC client, runs in browser
- **Rendering**: Canvas-based, processes binary frames via WebSockets
- **Performance**: CPU-bound in browser (JavaScript processing of binary data), laggy compression
- **Typical Latency**: 100-300ms depending on image complexity
- **Bandwidth**: 1-5 Mbps typical for moderate activity
- **Deployment**: Lightweight, stateless proxy architecture
- **Pros**: No installation, works in any modern browser
- **Cons**: Laggy interaction, high CPU on client (JavaScript), visible compression artifacts

### Modern WebRTC-Based Alternatives

#### **Neko** (Recommended for WebRTC approach)
- **Technology**: WebRTC peer-to-peer streaming, GStreamer video encoding
- **Latency**: 30-100ms typical (peer-to-peer + hardware encoding)
- **Performance**: Hardware video encoding (H.264/VP8/VP9) offloaded to GPU or CPU SIMD
- **Bandwidth**: 2-8 Mbps at good quality, adapts to network conditions
- **Multi-user**: Built-in support for multiple users observing same session
- **Audio**: Native audio support
- **Deployment**: Docker-native (m1k1o/neko), self-contained
- **Pros**: Smooth interactive experience, modern codec support, peer-to-peer efficiency
- **Cons**: Requires WebRTC infrastructure (TURN servers if behind NAT), smaller ecosystem than VNC
- **GitHub**: https://github.com/m1k1o/neko

#### **Selkies** (Enterprise-grade WebRTC)
- **Technology**: WebRTC + GStreamer with optional GPU acceleration
- **Performance**: 30+ FPS at 720p software, 60+ FPS at 1080p with NVIDIA GPU
- **Latency**: 20-80ms with proper tuning
- **Bandwidth**: 1-3 Mbps at quality settings comparable to Neko
- **Deployment**: Kubernetes-native, Xvfb compatible, designed for cloud/HPC
- **Ecosystem**: Academic origins (Google engineers), used in production research clusters
- **Pros**: GPU acceleration, scalable, low-latency, extensive tuning
- **Cons**: More complex deployment, steeper learning curve
- **GitHub**: https://github.com/selkies-project/selkies

#### **Apache Guacamole**
- **Protocol**: Custom protocol (not standard VNC/RDP)
- **Performance**: Server-side processing, better than noVNC but heavier than WebRTC
- **Bandwidth**: 2-4 Mbps typical
- **Features**: RDP/SSH/VNC gateway, broader protocol support
- **Complexity**: More infrastructure (Java backend, message broker)
- **Use Case**: Enterprise multi-protocol gateway, not optimal for single-protocol Chrome
- **Trade-off**: Feature breadth vs. single-purpose efficiency

### Recommendation

**Two-Tier Approach:**

1. **Primary: Neko (WebRTC)**
   - Fast deployment in Docker
   - Superior UX (lower latency, smooth interaction)
   - Bandwidth efficient
   - Multi-user viewing capability for demos/debugging
   - Per-instance URL streaming works well with browser architecture
   - **Latency**: 30-100ms vs. noVNC's 100-300ms

2. **Fallback: noVNC** (optional, for compatibility)
   - If client behind restrictive NAT (WebRTC TURN required)
   - Backup for TURN server failures
   - Browser compatibility edge cases

**Setup Architecture**:
```
Browser Instance (Docker)
  ├─ Headless Chrome running on :9222 (DevTools protocol)
  ├─ Xvfb running on :99 (virtual X server)
  ├─ Neko service (WebRTC streaming on :8080)
  └─ Optional: VNC server on :5900 (fallback)

User Browser
  └─ Connects to neko WebRTC stream via unique URL
```

**Xvfb/Xdummy Selection**:
- **Xvfb**: Virtual framebuffer, works well with Neko, ~50MB RAM overhead
- **Xdummy**: Slightly lighter, equivalent functionality
- **Recommendation**: Xvfb, more widely tested with Neko/Selkies

---

## 3. WireGuard Tunneling for Private Network Access

### Architecture Overview

**Goal**: Enable remote browser instance to access user's private network (local dev/staging servers) securely and isolated from other users.

### WireGuard Fundamentals

- **Protocol**: Modern, kernel-space VPN (significantly faster than userspace OpenVPN)
- **Keys**: Curve25519-based key exchange, simplifies management vs. IPsec/OpenVPN
- **Encryption**: ChaCha20-Poly1305, high performance
- **MTU**: ~1420 bytes (slightly smaller than standard 1500)
- **Setup**: Each peer identified by public key, assigned private IP in tunnel

### Per-User Tunnel Architecture

**Key Requirements**:
1. Each browser instance ↔ unique WireGuard tunnel to user's network
2. User controls who gets access (new keys per session)
3. Isolation: browser instance cannot see other users' tunnels
4. Routing: browser instance has default route to user's network

**Implementation Approaches**:

#### **Approach 1: wg-quick + Systemd (Lightweight, No Central Control)**

```
For each user session:
1. Generate ephemeral keypair (32-byte Curve25519)
2. Create WireGuard config for browser instance
3. Create WireGuard config for user's device (allowlist the browser's key)
4. User imports config or receives key via secure channel
5. Browser instance: wg-quick up <config>
6. Network isolation: Each instance in separate netns or system container
```

**Pros**:
- No central management server
- Lightweight, minimal overhead
- Direct peer-to-peer WireGuard (no intermediary)
- User controls key generation/distribution

**Cons**:
- Manual key management (not scalable for 100s of users)
- User must configure on their network side
- Complex key rotation/revocation
- Requires user to run WireGuard on their device

#### **Approach 2: Tailscale/NetBird/Headscale (Managed, Zero-Config)**

**Tailscale** (Proprietary Control Plane, Easiest):
- Automatic NAT traversal, no TURN servers needed
- Single authentication → all devices connected
- Hosted control plane (Tailscale's servers manage keys)
- **Limitation**: Proprietary; not ideal if privacy-critical

**NetBird** (Open-Source, Self-Hosted, Recommended):
- Open-source control plane + Tailscale client compatibility
- Self-hosted management server (you control everything)
- Automatic peer discovery + NAT traversal via TURN
- User authenticates once, keys managed server-side
- Since v0.65 (Feb 2026): Built-in reverse proxy for inbound routing
- **Best for**: Self-hosted, privacy-focused, scalable key management

**Headscale** (Open-Source, Tailscale-Compatible):
- Replaces Tailscale's control plane with open-source alternative
- Uses official Tailscale clients (compatibility)
- Lightweight coordinator server
- **Trade-off**: Smaller ecosystem vs. NetBird's dedicated project

**Architecture with NetBird**:
```
Control Server (NetBird)
  ├─ User authenticates (SSO/API key)
  ├─ Allocates IP pool for user's tunnel (e.g., 10.x.x.x/24)
  ├─ Issues certificates to browser instance
  └─ Manages peer discovery + routing rules

Browser Instance
  ├─ NetBird client (daemon)
  ├─ Receives assigned private IP from server
  ├─ Automatically routes to user's network
  └─ No key management burden on user

User's Device/Network
  ├─ NetBird client on device or gateway
  └─ Automatically discovers & connects to browser instance
```

**Advantages**:
- Zero configuration for user (after authentication)
- Automatic NAT traversal (works behind corporate NAT)
- Built-in DNS management (can reach local dev servers by hostname)
- Scalable to 1000s of concurrent users
- Key rotation automatic
- Easy revocation (disable user = all tunnels drop)

### Recommended Approach: Hybrid WireGuard + NetBird

1. **Primary**: NetBird for key management + peer discovery
   - User authenticates once
   - Browser instance automatically gets network access
   - Scales easily, minimal ops overhead
   - Built-in reverse proxy for inbound if needed

2. **Secondary**: Per-session ephemeral keys
   - Generate new key per browser session (30-min lifetime)
   - Automatic cleanup on session end
   - Even if user's credentials compromised, only current sessions leak

### Isolation Between Users

**Network Isolation**:
- NetBird ACLs (access control lists) enforce routing rules
- Browser instance A cannot route to Browser instance B's allocated IPs
- User A's network unreachable from Browser B

**Network Namespace Isolation** (Linux):
- Each browser container in separate network namespace
- Container has its own routing table, WireGuard interface
- Even with compromised browser, cannot access host network

**Practical Flow**:
```
1. User logs in to remote-browser-mcp dashboard
2. Request new browser session
3. System:
   - Generates ephemeral NetBird client cert for instance
   - Starts Docker container with WireGuard/NetBird enabled
   - Adds user to ACL on NetBird server
   - User can now access browser instance
4. Browser instance automatically routes to user's network
5. Session timeout → kill container → automatically revoke access
```

---

## 4. Hetzner-Specific Considerations

### Hardware Options

#### **AX41-NVMe** (Recommended Baseline)
- **CPU**: 6-core AMD Ryzen 5000 series (high single-thread, good for VNC streaming)
- **RAM**: 64GB DDR4
- **Storage**: 2x 512GB NVMe (fast, good for container startup)
- **Network**: 1 Gbps, Unlimited traffic (as of 2025)
- **Cost**: ~€40-45/month
- **Scalability**: Single unit supports ~25-40 concurrent user sessions comfortably

#### **AX161-NVMe** (High Concurrency)
- **CPU**: 16-core Ryzen (better CPU scaling)
- **RAM**: 128GB
- **Better for**: 80-120 concurrent sessions
- **Cost**: Higher but better price-per-concurrent-user for large deployments

### Networking

#### **Private Networks**
- Hetzner offers private networks (Layer 2 isolated)
- Use for inter-server communication (browser instances don't need this)
- Useful for database/cache servers on same network

#### **Floating IPs**
- Reserve IP for failover/relocation
- Useful if running multi-node cluster
- Not needed for single AX41

#### **Bandwidth**
- Unlimited outbound (as of 2025 pricing)
- Covered under server rental
- WebRTC/VNC streaming costs included (no overage charges typical for VPN/VNC)

### Bare Metal vs. Cloud

**Recommendation: Bare Metal (AX41)**
- Dedicated resources (no noisy neighbors)
- Consistent performance critical for interactive VNC/WebRTC
- Better price-per-performance than cloud VMs
- Full control of kernel/network stack (needed for WireGuard netns isolation)
- Hetzner's bare metal excellent stability

**When to use Cloud**:
- Development/testing environment only
- If requiring hyper-scale (100+ instances) with auto-scaling

### Scaling Strategy

#### **Single Server** (Initial/MVP)
- 1x AX41-NVMe
- 25-40 concurrent users max
- Stateful (containers on single machine)
- Simple backup strategy (nightly snapshots)

#### **Multi-Server Cluster** (100+ users)
- 3-5x AX41-NVMe
- Load balancer (Nomad or Kubernetes)
- Shared state layer (Redis for session management)
- Hetzner private network for inter-server comms

#### **Auto-Scaling** (Dynamic load)
- Not recommended on Hetzner bare metal (slow provisioning)
- Better approach: Static pool + custom scaling logic
  - Monitor usage patterns
  - Pre-provision servers at low-traffic times
  - Decommission during night/weekends
  - Hetzner API for programmatic provisioning

### Cost Model

**Single AX41 @ 40/month:**
- 25 concurrent users = €1.60/user/month (infrastructure only)
- 40 concurrent users = €1.00/user/month

**Scaling considerations**:
- Additional AX41 adds fixed cost, scales linearly with users
- Bandwidth not bottleneck (unlimited on Hetzner)
- CPU is primary constraint (6-core limits concurrent active workloads)

---

## 5. Orchestration: Managing Browser Instance Lifecycle

### Orchestration Requirements

1. **Instance Creation**: Spin up Docker container with Chrome + VNC/WebRTC + WireGuard
2. **Discovery**: Load balancer knows instance location + how to reach it
3. **Health Monitoring**: Detect crashed instances, container restarts
4. **Cleanup**: Terminate on session end, collect logs, update load balancer
5. **Scaling**: Add/remove nodes based on demand
6. **Resource Limits**: Enforce CPU/memory per instance, prevent resource starvation

### Option 1: Kubernetes (Full-Featured, Complex)

**Use Case**: Multi-node cluster, 100+ concurrent users, cloud-native

**Architecture**:
```
Kubernetes Control Plane
├─ kube-apiserver, etcd, scheduler
├─ Runs on 1 dedicated AX41 or cloud small VM
└─ Manages browser instance pods

Worker Nodes (N x AX41-NVMe)
├─ Kubelet daemon
├─ Docker runtime
├─ Browser instance pods
└─ Network via overlay (Flannel/Calico)

Load Balancer
├─ Service of type LoadBalancer (Hetzner LB or ingress)
└─ Routes user → pod endpoint
```

**Pros**:
- Industry standard orchestration
- Auto-scaling (Horizontal Pod Autoscaler)
- Self-healing (replace crashed pods)
- Declarative configuration (GitOps-friendly)
- Multi-cloud portability

**Cons**:
- Operational overhead (etcd, control plane HA)
- Complexity overkill for <50 concurrent users
- Learning curve, requires Kubernetes expertise
- Resource overhead (control plane ~5-10% of cluster resources)

**Viable For**: Teams already running Kubernetes, 100+ users, auto-scaling requirement

### Option 2: Nomad (Lighter, More Flexible)

**Use Case**: Multi-node cluster, heterogeneous workloads, lighter overhead

**Architecture**:
```
Nomad Servers (3x, high-availability)
├─ Cluster coordination (consensus)
├─ Can coexist with browser instances
└─ Resource overhead: ~200MB RAM each

Nomad Clients (N x AX41)
├─ Task executor (Docker, exec, Java, etc.)
├─ Browser instance jobs
└─ Minimal overhead compared to Kubernetes

Load Balancer
├─ Routes to Nomad service discovery
└─ DNS or custom health checks
```

**Pros**:
- Lower operational overhead than Kubernetes
- Supports Docker + VMs + raw binaries (broader workload types)
- Simpler configuration files (HCL) vs. Kubernetes YAML
- Better for small-to-medium clusters (10-50 nodes)
- Fewer moving parts

**Cons**:
- Smaller ecosystem than Kubernetes
- Less mature auto-scaling
- Fewer hosted options (must self-host control plane)

**Viable For**: Multi-node cluster, <200 concurrent, prefer simplicity

### Option 3: systemd + Custom Orchestration (Minimal, DIY)

**Use Case**: Single/small multi-node, high control, minimal dependencies

**Architecture**:
```
systemd service units (per browser session)
├─ Start container: systemd-run docker run ...
├─ Lifecycle: On-demand startup, configurable TTL
└─ Logging: journalctl for unified logs

Load Balancer (HAProxy or custom)
├─ Register/deregister instances via API
├─ Health check via HTTP or TCP

Session Manager (Custom)
├─ Track active sessions
├─ Trigger systemd-run for new instances
├─ Cleanup on session end
└─ Written in Python/Go
```

**Pros**:
- No external orchestration dependencies
- Full control of lifecycle
- Lightweight (systemd is init on most Linux)
- Familiar (systemd is standard on Ubuntu 24)
- Good for 5-20 node deployments

**Cons**:
- Custom development required
- No built-in auto-scaling
- Operational burden on team
- Scaling logic must be custom-written

**Viable For**: MVP, single team, <50 concurrent users, high customization needs

### Recommended Approach: Nomad (Balanced)

**Rationale**:
- Scales from single-node to 50+ nodes easily
- Lighter than Kubernetes (relevant on Hetzner bare metal with limited CPU)
- Good ecosystem for VCS integration
- HCL configuration simpler to reason about

**Nomad Job for Browser Instance**:
```hcl
job "browser" {
  datacenters = ["eu-central"]
  
  task "chrome-neko" {
    driver = "docker"
    config {
      image = "remotebrowser/chrome-neko:latest"
      ports = ["neko"]
      memory = 450
      cpu = 500
    }
    
    service {
      name = "browser"
      port = "neko"
      check {
        type = "tcp"
        interval = "10s"
        timeout = "2s"
      }
    }
    
    resources {
      memory = 450
      cpu = 500
    }
  }
}
```

**Session Lifecycle**:
1. User requests new session
2. Control plane (Python/Go) submits Nomad job
3. Nomad scheduler finds best client node
4. Container starts, registers with service discovery
5. User receives URL pointing to neko endpoint
6. Session timeout (user idle 30+ min or TTL expires)
7. Control plane stops Nomad job
8. Container cleaned up, service deregistered

---

## Implementation Priority & Phasing

### Phase 1 (MVP: Single Node, <20 concurrent users)
- **Infrastructure**: 1x Hetzner AX41-NVMe
- **Containerization**: Docker + resource limits (cgroups)
- **Streaming**: Neko (WebRTC)
- **Networking**: NetBird for WireGuard tunneling
- **Orchestration**: systemd + simple Python session manager
- **Timeline**: 2-4 weeks to production MVP

### Phase 2 (Scaling: 50-100 concurrent users)
- **Infrastructure**: 3x AX41-NVMe + Nomad cluster
- **Improvements**: Monitoring (Prometheus), log aggregation (ELK)
- **High Availability**: Session state in Redis
- **Timeline**: 4-6 weeks

### Phase 3 (Enterprise: 200+ concurrent users)
- **Optional Migration**: Kubernetes if org already uses it
- **Improvements**: GPU support (for advanced use cases), Custom scaling logic
- **SLA**: 99.9% uptime target
- **Timeline**: Ongoing

---

## Summary Table: Technology Decisions

| Aspect | Choice | Rationale |
|--------|--------|-----------|
| **Container Runtime** | Docker (+ optional Kata for security tiers) | Proven, extensive Chrome tooling, ~300-500MB/instance |
| **Display Streaming** | Neko (WebRTC, primary) + noVNC (fallback) | Low latency (30-100ms), bandwidth efficient, modern UX |
| **Private Network Access** | NetBird + WireGuard | Zero-config for users, automatic key management, scalable |
| **Hetzner Server** | AX41-NVMe | 25-40 concurrent users, €40/mo, best price-to-performance |
| **Orchestration** | Nomad (multi-node), systemd (single-node MVP) | Lightweight, scales easily, simpler than Kubernetes |
| **VPN/Mesh** | NetBird self-hosted control plane | Open-source, self-contained, automatic NAT traversal |

---

## Key Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Chrome memory leak over long sessions | Implement session timeout (8-24 hours), periodic container restarts |
| Noisy neighbor (one user's workload impacts others) | Strict CPU/memory limits via cgroups, optional Kata Containers for isolation |
| WireGuard key compromise | Per-session ephemeral keys, short TTLs (30 min), audit logging |
| Hetzner bandwidth costs (if unlimited changes) | Monitor egress, implement CDN for static assets, compress WebRTC streams |
| Single AX41 SPOF | HA cluster (Phase 2), automated failover, Redis session backup |
| Xvfb rendering issues | Test with real Chrome workloads early, consider Xdummy alternative |

---

## References & Sources

### Container/Isolation
- [AWS: Kata Containers for Kubernetes](https://aws.amazon.com/blogs/containers/enhancing-kubernetes-workload-isolation-and-security-using-kata-containers/)
- [Firecracker vs Kata Containers Comparison](https://medium.com/@amrithalalk/firecracker-vs-kata-containers-isolation-as-defensive-strategy-910e1ebfee9b)
- [Northflank: Isolation Tools Comparison](https://northflank.com/blog/kata-containers-vs-firecracker-vs-gvisor)
- [systemd-nspawn Guide](https://quantum5.ca/2025/03/22/whirlwind-tour-of-systemd-nspawn-containers/)

### VNC/WebRTC Streaming
- [Neko GitHub](https://github.com/m1k1o/neko)
- [Selkies Project](https://github.com/selkies-project/selkies)
- [LinuxServer Webtop 4.0](https://www.linuxserver.io/blog/webtop-4-0-wayland-is-here-engage-the-reality-engine)

### WireGuard & VPN
- [WireGuard Official](https://www.wireguard.com/)
- [NetBird vs Tailscale Comparison](https://www.netbird.io/knowledge-hub/tailscale-vs-netbird)
- [Headscale Documentation](https://headscale.net/)
- [Top WireGuard Alternatives 2025](https://pinggy.io/blog/top_open_source_tailscale_alternatives/)

### Hetzner
- [AX41-NVME Specs](https://www.hetzner.com/dedicated-rootserver/ax41-nvme)
- [Hetzner Docs: AX Server Configuration](https://docs.hetzner.com/robot/dedicated-server/server-lines/ax-server/)
- [Hetzner vs Cloud Comparison 2025](https://www.achromatic.dev/blog/hetzner-server-comparison)

### Orchestration
- [Nomad vs Kubernetes](https://www.imaginarycloud.com/blog/nomad-vs-kubernetes)
- [Nomad Documentation](https://developer.hashicorp.com/nomad/docs/what-is-nomad)
- [Container Orchestration Platforms 2025](https://www.domo.com/learn/article/container-orchestration-platforms)

### Resource Requirements
- [Headless Chrome Memory/CPU FAQ](https://webscraping.ai/faq/headless-chromium/what-are-the-resource-requirements-for-running-headless-chromium-at-scale)
- [Browserless Observations](https://www.browserless.io/blog/2019/03/13/more-observations/)

---

**Document Date**: April 2026  
**Status**: Research Complete  
**Next Steps**: Detailed implementation plan for Phase 1 MVP
