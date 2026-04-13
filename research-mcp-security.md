# MCP Protocol Integration and Security Model Research

**Date:** 2026-04-13  
**Researcher:** Security Researcher  
**Project:** Hosted Browser MCP Service

---

## Executive Summary

This document synthesizes research on integrating the Model Context Protocol (MCP) with a hosted browser service running on Hetzner infrastructure. The key findings cover MCP transport mechanisms, browser tool implementations, multi-tenant security architecture, session management, and data protection strategies.

**Critical Finding:** MCP has transitioned from SSE to Streamable HTTP as the preferred transport. Current MCP deployments at scale show significant authentication gaps—scanning revealed nearly 2,000 internet-exposed MCP servers with zero authentication, creating exfiltration risks.

---

## 1. MCP Transport for Remote Servers

### 1.1 Transport Evolution

MCP supports three transports: **stdio, SSE (deprecated), and Streamable HTTP (recommended)**.

#### Streamable HTTP Transport (Current Standard)

As of MCP specification 2025-03-26, **Streamable HTTP is the preferred transport** for remote MCP servers. Key characteristics:

- **Endpoint Model:** Single HTTP endpoint (POST/GET) at a path like `https://example.com/mcp`
- **Request Pattern:** Client sends HTTP POST with MCP messages; server responds with HTTP response body
- **Streaming:** Optional Server-Sent Events (SSE) over the same connection for server-to-client streaming and notifications
- **Advantages:**
  - Stateless "sealed letter" model with stronger security than persistent connections
  - Works better with modern HTTP infrastructure (proxies, load balancers, CDNs)
  - Compatible with standard HTTP authentication (Bearer tokens, API keys, custom headers)
  - Cleaner separation of client-to-server (POST) and server-to-client (SSE) channels

#### SSE Transport (Deprecated but Supported)

- **Status:** Deprecated in favor of Streamable HTTP due to compatibility issues
- **Limitation:** One-way communication requires artificial separation between channels
- **Backward Compatibility:** Will continue to be supported for legacy implementations
- **Not Recommended:** For new remote MCP server deployments

#### Stdio Transport

- **Local only:** Used for local process-to-process communication
- **Not applicable:** For hosted remote browser service

### 1.2 Authentication Standards

#### OAuth 2.0/2.1 Integration

MCP has adopted **OAuth 2.0** as the standard for initial authentication and authorization:

- **Bearer Tokens:** Standard OAuth bearer tokens sent as `Authorization: Bearer <token>` header
- **Stateless:** Tokens are self-contained or reference-based; server doesn't maintain session state
- **Dynamic Client Registration (DCR):** Allows clients to auto-register without manual setup
- **Automatic Endpoint Discovery:** Metadata URLs enable clients to discover OAuth endpoints

#### API Key & Custom Header Support

- Streamable HTTP transport supports standard HTTP authentication methods
- API keys can be passed in Authorization headers or custom headers
- TLS/HTTPS is **mandatory** for token security—unencrypted tokens are trivially interceptable

#### Current Authentication Gap

**Critical Issue:** Security research (July 2025) scanning ~2,000 internet-exposed MCP servers found **100% lacking any form of authentication**. This enables:
- Unauthorized tool enumeration
- Sensitive data exfiltration
- Internal system reconnaissance

**Recommendation:** Implement strong authentication from day one using OAuth 2.0 bearer tokens or similar.

### 1.3 Implementation Pattern for Hosted Browser

```
User's AI Agent (Claude, etc.)
         ↓ (HTTPS)
    OAuth 2.0 Bearer Token
         ↓
Hosted Browser MCP Server (Hetzner)
    - POST /mcp endpoint
    - Validates token at each request
    - Optional SSE channel for streaming
    - Session ID in Mcp-Session-Id header
         ↓ (WireGuard VPN)
  User's Private Network
```

---

## 2. MCP Server Implementation for Browsers

### 2.1 Standard Browser Tools

Existing MCP browser implementations expose these core tools:

#### Navigation & Page Control
- `navigate(url)` - Load a URL
- `go_back()` / `go_forward()` - History navigation
- `reload()` - Refresh current page
- `wait(seconds)` - Pause execution

#### User Interaction
- `click(selector)` - Click an element
- `type(text)` - Type text (with optional selector for input field)
- `drag_drop(from_selector, to_selector)` - Drag and drop elements
- `hover(selector)` - Hover over element (triggers tooltips, etc.)

#### Information Retrieval
- `screenshot()` - Full page screenshot
- `get_dom()` - Retrieve current DOM structure
- `get_accessibility_snapshot()` - Get accessible tree for screen readers
- `get_console_logs()` - Retrieve browser console output
- `evaluate_js(code)` - Execute arbitrary JavaScript and return result

#### Advanced Tools
- `lighthouse_audit()` - Run Lighthouse performance audit
- `select_element(selector)` - Interactive element selector with UI overlay
- `get_network_logs()` - Monitor network requests/responses

### 2.2 Long-Running Operations & Streaming

Key pattern for handling operations that take time to complete:

#### Async Execution Pattern
1. Client calls tool (e.g., `navigate("https://app.local")`)
2. Server initiates operation, returns immediately with operation ID
3. Client can poll for status or subscribe to SSE notifications
4. Server streams intermediate results (page load progress, screenshot ready)
5. Final result delivered as complete message

#### Implementation Considerations
- Use operation IDs to track long-running tasks
- SSE channel for progress notifications
- Timeout handling: operations that don't complete within X seconds should fail gracefully
- Resource limits: prevent clients from spawning unlimited concurrent operations

### 2.3 Recommended Architecture

```
Browser MCP Server (Node/TypeScript + Express/Hapi)
├── HTTP Server (Streamable HTTP transport)
│   ├── POST /mcp - Request handling
│   ├── SSE - Stream responses & notifications
│   └── Authentication middleware (OAuth bearer tokens)
├── Browser Pool Manager
│   ├── Allocate/deallocate browser instances
│   ├── Track active operations per instance
│   └── Resource limits enforcement
├── Puppeteer/Playwright Process
│   ├── Isolated browser context per session
│   └── Network isolation (WireGuard + container namespace)
└── Logging & Monitoring
    ├── Request logs (authentication, tool calls)
    ├── Performance metrics
    └── Security events
```

---

## 3. Security Model

### 3.1 Multi-Tenancy & Browser Isolation

#### Isolation Layers (Defense in Depth)

1. **Process Isolation (Container Level)**
   - Each tenant's browser runs in a separate Docker container
   - Container namespaces prevent process visibility between containers
   - Control groups (cgroups) enforce resource limits per tenant:
     - CPU shares (e.g., 1024 shares per tenant)
     - Memory limits (e.g., 2GB per browser instance)
     - Disk I/O bandwidth limits
     - Process count limits
   - No shared filesystem between containers

2. **Network Isolation (Linux Network Namespace)**
   - Each tenant browser in its own network namespace
   - Dedicated virtual interface or bridge for each namespace
   - Network policies block cross-tenant traffic (iptables rules)
   - WireGuard tunnel only connects tenant's namespace to their private network
   - Host network completely isolated from tenant namespaces

3. **Virtual Machine Isolation (for highest security)**
   - Alternative to container-only approach: Kata Containers or Hyper-V isolation
   - Trade-off: Higher resource overhead, slower startup (~2-5s vs <100ms)
   - Recommended for government/finance compliance requirements

#### Multi-Tenant Data Isolation

- **Session IDs:** Each browser session gets a unique, cryptographically random session ID
- **Storage:** Session state stored separately per ID (Redis or persistent store)
- **API Access:** Bearer token tied to specific tenant; server validates token→tenant mapping on every request
- **No Cross-Tenant Data Leakage:** Queries like "list all sessions" must filter by authenticated tenant

### 3.2 WireGuard + Browser Security Model

#### WireGuard Architecture

```
┌─────────────────┐
│  User Network   │
│  (e.g., 10.0.0.0/8)
└────────┬────────┘
         │ (WireGuard Tunnel)
    Private Key Auth
         ↓
┌─────────────────────────────────────┐
│  Hosted Browser (Hetzner)           │
│  ┌───────────────────────────────┐  │
│  │  WireGuard Interface          │  │
│  │  (Endpoint: 10.1.x.x)         │  │
│  └─────────────┬─────────────────┘  │
│                │                     │
│  ┌─────────────▼──────────────────┐ │
│  │  Docker Container (Tenant 1)   │ │
│  │  ├─ Network Namespace          │ │
│  │  ├─ Browser Instance           │ │
│  │  └─ Routes to User Network via │ │
│  │     WireGuard (10.0.x.x)       │ │
│  └────────────────────────────────┘ │
│                                     │
│  ┌─────────────────────────────────┐ │
│  │  Docker Container (Tenant 2)   │ │
│  │  ├─ Network Namespace          │ │
│  │  ├─ Browser Instance           │ │
│  │  └─ Isolated from Tenant 1     │ │
│  └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

#### Threat: Lateral Movement Prevention

**Attack Scenario:**
1. Attacker compromises browser in Tenant A's container
2. Attacker attempts to pivot to Tenant B's container or user network

**Mitigation Strategies:**

- **Mutual Authentication:** WireGuard uses cryptographic peer authentication; compromised browser cannot reconfigure tunnel to connect to different endpoints
- **Network Policies:** iptables rules on host prevent inter-container traffic unless explicitly allowed (default-deny)
- **Namespace Isolation:** Browser process in Container A literally cannot see Container B's network interface
- **Monitoring:** Alert on unexpected network connections, unusual outbound traffic from browser containers

#### Threat: Tunnel Hijacking

**Mitigation:**
- WireGuard tunnel credentials (private keys) stored securely in container at deployment time, read-only after startup
- No mechanism for browser to modify WireGuard configuration
- Separate audit logs for tunnel usage; monitor for anomalies
- Regular key rotation policy (e.g., rotate every 90 days)

### 3.3 Session Authentication

#### Bearer Token Flow

```
1. User authenticates to control plane → gets OAuth bearer token
2. User provides token to their AI agent configuration
3. AI agent includes token: Authorization: Bearer <token>
4. Hosted browser server:
   - Validates token signature/expiration
   - Maps token → User ID/Tenant ID
   - Returns session ID (random UUID)
   - Stores session state under tenant isolation boundary
5. Subsequent requests include Mcp-Session-Id header
   - Server validates session exists for authenticated tenant
   - Session timeout: 24 hours (configurable)
```

#### Token Security

- **Format:** Signed JWT or opaque token referencing server database
- **Expiration:** 1-24 hours (short-lived tokens reduce replay attack window)
- **Transmission:** HTTPS only (TLS 1.3+)
- **Storage:** Tokens never logged to disk; only hashed values in audit logs
- **Revocation:** Support immediate revocation via server-side token blacklist (Redis)

#### Multi-Tenant Token Validation

```python
def validate_token(token: str, http_headers: dict) -> (tenant_id, user_id):
    try:
        payload = jwt.decode(token, public_key)
        tenant_id = payload['tenant_id']
        user_id = payload['user_id']
        
        # Critical: Verify session tenant matches token tenant
        session_id = http_headers.get('Mcp-Session-Id')
        if session_id:
            stored_tenant = redis.get(f"session:{session_id}:tenant")
            if stored_tenant != tenant_id:
                raise Unauthorized("Session tenant mismatch")
        
        return tenant_id, user_id
    except jwt.ExpiredSignatureError:
        raise Unauthorized("Token expired")
```

### 3.4 Data at Rest

#### Encryption Standards

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key Derivation:** PBKDF2 or Argon2 for key derivation from master secret
- **Encrypted Data Types:**
  - Session state (DOM snapshots, cookies, local storage)
  - Logs containing user data or interactions
  - WireGuard configuration (private keys)
  - OAuth tokens stored server-side

#### Encryption Key Management

- **Master Key:** Stored in encrypted environment variable or secret manager (AWS Secrets Manager, HashiCorp Vault)
- **Per-Session Key:** Optional; derive from master key + session ID for additional isolation
- **Disk Encryption:** Enable host-level disk encryption (LUKS on Linux) for entire Hetzner VM
- **Key Rotation:** Implement without downtime using envelope encryption pattern

#### What Not to Encrypt (by default)

- Request/response timing metadata (needed for performance monitoring)
- Tool call names (navigate, click, screenshot) — reveals tool usage, not sensitive by itself
- Session count metrics — needed for billing/SLO monitoring

#### Logging Strategy

```
Log Level | Content | Encryption | Retention
----------|---------|------------|----------
ERROR     | Tool name, error type | No | 90 days
WARN      | Auth failures, timeout | No | 30 days
INFO      | Request count, perf | No | 7 days
DEBUG     | Full request/response | Yes (AES-256) | 1 day (local only)
AUDIT     | All auth events, token usage | Yes (AES-256) | 1 year
```

### 3.5 Browser Sandbox Escape Risks

#### Attack Vectors in Chromium/Firefox

**Recent Vulnerabilities:**
- **CVE-2025-2857 (Firefox):** Improper IPC handling allows compromised child process to gain elevated privileges
- **CVE-2025-2783 (Chrome):** Logical error in sandbox + Mojo IPC framework enables sandbox escape
- **Win32k Attacks:** Windows-specific attacks exploiting dangerous system calls (less relevant on Ubuntu 24+)

#### Hosted Browser Risk Model

1. **Confined Attack Surface:** 
   - Attacker controls browser tab content only
   - Cannot directly invoke host syscalls or access parent process
   - Chromium multi-process isolation (9+ processes) provides first line of defense

2. **Escape Chain Required:**
   - Attacker needs *two* exploits: (1) browser vulnerability + (2) sandbox escape
   - Chromium has more mature process isolation than Firefox (GPU process, socket process, audio process on Linux)
   - Recent patches (2025) have addressed critical sandbox escape vectors

3. **Post-Escape Containment:**
   - If browser process escapes its Chromium sandbox, Docker container namespace still isolates it
   - If container namespace is breached, iptables rules prevent network lateral movement
   - OS-level seccomp rules can further restrict host syscalls available to container

#### Mitigation Recommendations

- **Browser Selection:** Use Chromium/Chrome over Firefox for superior multi-process isolation
- **Auto-Patching:** Deploy weekly security updates for browser + kernel (Ubuntu 24 LTS provides stable updates)
- **Seccomp Profiles:** Use Docker seccomp policy to block dangerous syscalls (e.g., ptrace, mount, raw sockets)
- **AppArmor:** Enable Ubuntu AppArmor profiles for additional process confinement
- **Kernel Hardening:** Deploy Grsecurity or standard Ubuntu hardening (ASLR, DEP/NX, stack canaries)
- **Timeout Limits:** Forcibly kill browser processes older than 24 hours (prevents long-running exploit chains)
- **Untrusted Content Warning:** Document that hosting untrusted websites carries inherent risk despite layered mitigations

### 3.6 Data in Transit

#### HTTPS/TLS Configuration

- **Minimum Version:** TLS 1.3 only (disable TLS 1.2)
- **Cipher Suites:** Modern suites only (no legacy ciphers)
  - TLS_AES_256_GCM_SHA384
  - TLS_CHACHA20_POLY1305_SHA256
- **Certificate Management:** Auto-renewing certificates (Let's Encrypt via cert-manager or similar)
- **HSTS:** Enable HTTP Strict-Transport-Security (min-age: 31536000, includeSubDomains, preload)

#### WireGuard Encryption

- **Algorithm:** WireGuard uses Noise Protocol with Curve25519, ChaCha20, Poly1305
- **Perfect Forward Secrecy:** Each packet encrypted with ephemeral keys derived from static keys
- **Authentication:** Every packet is authenticated; tampering detected immediately
- **No Known Weaknesses:** WireGuard protocol itself is considered cryptographically sound (academic review)

#### SSE Stream Security

- Transmitted over HTTPS (inherits TLS protection)
- No additional encryption needed; TLS provides confidentiality/integrity
- Optional: Encrypt individual message payloads end-to-end if extra paranoia desired

---

## 4. Session Management

### 4.1 Session Lifecycle

#### Creation

```
1. Client POST /mcp with Authorization: Bearer <token>
2. Server validates token, maps to tenant_id
3. Server generates session_id = UUID()
4. Server stores in Redis:
   - session:{session_id}:tenant = tenant_id
   - session:{session_id}:created_at = timestamp
   - session:{session_id}:last_activity = timestamp
   - session:{session_id}:browser_pid = <process_id>
5. Server returns session_id in response header (Mcp-Session-Id)
```

#### Timeout & Cleanup

- **Idle Timeout:** 30 minutes (no activity) → session terminated
- **Absolute Timeout:** 24 hours (max session duration) → forced termination
- **Cleanup Job:** Background task scans Redis every 5 minutes, evicts expired sessions
- **Browser Cleanup:** Associated browser process killed on session termination

#### Reconnection (Resume After Disconnect)

MCP Streamable HTTP specification provides reconnection mechanism:

```
Client Connection Lost
         ↓
Client issues HTTP GET to /mcp
Header: Last-Event-ID: <event_id>
Header: Mcp-Session-Id: <session_id>
         ↓
Server looks up session:
  - If found & still valid → continue streaming from event_id
  - If not found → return HTTP 404
  - If session exists but expired → client must create new session
         ↓
Client handles 404 → creates new session with fresh InitializeRequest
```

#### Browser State Persistence (Optional)

**Stateless Approach (Recommended):**
- Browser state not persisted; reconnection gives fresh browser state
- Simpler implementation, less storage overhead
- Acceptable for testing workflows (user re-navigates to page)

**Stateful Approach (Advanced):**
- Snapshot browser DOM/cookies/storage on client disconnect
- Restore state on reconnection
- Requires serialization of Chromium process state (complex)
- Trade-off: Slower startup but transparent reconnection

### 4.2 Multi-Worker Deployment Challenge

**Issue:** When MCP server runs behind load balancer with multiple workers (gunicorn, Node cluster module), SSE sessions created in Worker A become unreachable if client request is routed to Worker B.

**Solution Pattern:**

```
Load Balancer (sticky sessions enabled)
  ↓
Route all requests with same Mcp-Session-Id to same worker
  ↓
Use shared session store (Redis) instead of in-process memory
  ↓
Each worker can read/update session from Redis
```

**Implementation:**
```javascript
// Every worker reads/writes session to Redis, not memory
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] || generateId();
  const session = await redis.get(`session:${sessionId}`); // Shared!
  
  if (!session) {
    // Create new session
    session = { id: sessionId, tenant_id, created_at: Date.now() };
    await redis.setex(`session:${sessionId}`, 86400, JSON.stringify(session));
  }
  
  // Process request...
  await redis.set(`session:${sessionId}:last_activity`, Date.now());
});
```

### 4.3 Graceful Degradation

#### Timeout Behavior

1. **Server detects client disconnect (no heartbeat for 5 min)**
   - Do NOT kill browser immediately
   - Log event with session ID for debugging
   - Keep browser alive for reconnection window (10 min)

2. **Client issues reconnect request after 30 seconds**
   - Server resumes with existing browser instance
   - No state lost; user can continue

3. **If no reconnect within grace period (10 min)**
   - Browser process killed, resources freed
   - Session marked for deletion after 24 hours

---

## 5. Recommended Architecture Summary

### Component Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Transport** | Streamable HTTP + SSE | Modern MCP standard; OAuth-friendly |
| **Auth** | OAuth 2.0 Bearer Tokens (JWT) | Industry standard; stateless; revokable |
| **Browser Engine** | Chromium/Chrome | Superior multi-process isolation vs Firefox |
| **Server Framework** | Node.js (Express/Hapi) + Puppeteer/Playwright | Mature MCP ecosystem; JS language match for browser automation |
| **Containerization** | Docker + Kubernetes OR Docker Compose | Multi-tenant isolation via namespaces; resource limits via cgroups |
| **Session Store** | Redis | Fast; supports TTL; shared across workers |
| **Encryption at Rest** | AES-256-GCM | Industry standard; authenticated encryption |
| **VPN** | WireGuard | Modern; cryptographically sound; low overhead |
| **Monitoring** | Prometheus + Grafana | Standard observability; alert on auth failures, resource limits |

### Deployment Topology (Hetzner Ubuntu 24)

```
Hetzner VM (Ubuntu 24)
├─ Disk Encryption (LUKS)
├─ Firewall (ufw)
│  ├─ Allow: HTTPS (443) from internet
│  ├─ Allow: WireGuard (51820/UDP) from internet
│  └─ Drop: All else
├─ Docker Daemon
│  ├─ Network namespace per container
│  ├─ Container 1: Node.js MCP Server + OAuth
│  ├─ Container 2: Browser instance (Tenant A, WireGuard 10.1.1.2)
│  ├─ Container 3: Browser instance (Tenant B, WireGuard 10.1.2.2)
│  └─ Container N: Browser instance (Tenant N, ...)
├─ Redis (in-memory session store, encrypted at rest)
├─ WireGuard Interface (10.1.0.1/24)
└─ Logging (journald → ELK or CloudWatch)
```

---

## 6. Key Decisions & Trade-offs

### Decision: Stateless HTTP Over Stateful WebSocket

**Chosen:** Streamable HTTP  
**Alternatives Considered:**
- WebSocket (older pattern): persistent connections, harder to authenticate, no request boundaries
- Plain REST: verbose, not designed for streaming responses

**Rationale:**
- MCP spec moved away from SSE in favor of this model
- Easier to secure: each request includes auth token
- Works with proxies, CDNs, load balancers
- Can implement request timeout/rate limiting at HTTP level

### Decision: Container Isolation Over VM Isolation

**Chosen:** Docker containers (soft multi-tenancy) with fallback to Kata Containers (hard multi-tenancy)  
**Alternatives Considered:**
- Full VMs per tenant: maximum isolation but extreme resource overhead
- No isolation: cheapest but single vulnerability compromises all users

**Rationale:**
- Container namespaces + iptables provide adequate isolation for most use cases
- Resource-efficient: 10-50 browsers per server vs 2-5 full VMs
- Kata Containers available as drop-in upgrade if stricter isolation needed

### Decision: No Browser State Persistence

**Chosen:** Stateless — reconnection results in fresh browser  
**Alternatives Considered:**
- Snapshot/restore browser state on disconnect

**Rationale:**
- Significantly reduces complexity
- Most testing workflows re-navigate anyway
- Avoids serialization overhead and potential data leaks during snapshot

---

## 7. Implementation Priorities

1. **Phase 1 (MVP):** 
   - Streamable HTTP transport with OAuth bearer token auth
   - Single-tenant or isolated testing only
   - Basic Puppeteer browser tools (navigate, click, screenshot, DOM)
   - Simple JSON session store (no Redis yet)

2. **Phase 2 (Multi-tenant):**
   - Redis session store
   - Network namespace isolation per container
   - iptables rules to prevent cross-tenant traffic
   - WireGuard tunnel setup

3. **Phase 3 (Hardening):**
   - Disk encryption, AppArmor profiles, seccomp rules
   - Automatic security updates
   - Full audit logging + SIEM integration
   - Kubernetes migration (vs Docker Compose)

4. **Phase 4 (Scale):**
   - Kata Containers for hard multi-tenancy (if needed)
   - Distributed session store (Consul/etcd)
   - Advanced monitoring (browser resource exhaustion, exploit detection)

---

## References

### MCP Protocol
- [MCP Specification - Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP Server Transports - Roo Code](https://docs.roocode.com/features/mcp/server-transports)
- [Why MCP Deprecated SSE - fka.dev](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [MCP Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP Security Risks and Controls - RedHat](https://www.redhat.com/en/blog/model-context-protocol-mcp-understanding-security-risks-and-controls)

### Browser MCP Implementations
- [Playwright MCP Server - Supported Tools](https://executeautomation.github.io/mcp-playwright/docs/playwright-web/Supported-Tools)
- [Browser MCP - Automate Your Browser](https://browsermcp.io/)
- [Screenshot MCP Server](https://github.com/sethbang/mcp-screenshot-server)
- [DOM Screenshot MCP](https://github.com/adtac/domshot)

### Authentication & OAuth
- [Bearer Token Usage - RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750)
- [OAuth 2.0 Bearer Tokens](https://oauth.net/2/bearer-tokens/)
- [API Authentication Guide - WorkOS](https://workos.com/blog/what-is-api-authentication-a-guide-to-oauth-2-0-jwt-and-key-methods)

### Multi-Tenancy & Isolation
- [Kubernetes Multi-Tenancy Documentation](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
- [Namespace Isolation Best Practices - OneUptime](https://oneuptime.com/blog/post/2026-02-09-multi-tenancy-namespace-isolation/view)
- [Tenant Isolation in Multi-Tenant Systems - WorkOS](https://workos.com/blog/tenant-isolation-in-multi-tenant-systems)
- [Docker Container Isolation & Namespaces - DEV](https://dev.to/hexshift/container-isolation-understanding-namespaces-and-control-groups-in-docker-318b)
- [Microsoft Entra Multi-Tenant Resource Isolation](https://learn.microsoft.com/en-us/entra/architecture/secure-multiple-tenants)

### WireGuard & VPN Security
- [Preventing Lateral Movement With WireGuard - Pro Custodibus](https://www.procustodibus.com/blog/2023/01/prevent-lateral-movement-with-wireguard/)
- [VPN Sandbox - Network Isolation](https://github.com/vm75/vpn-sandbox)
- [WireGuard Guide - Zenarmor](https://www.zenarmor.com/docs/network-security-tutorials/wireguard)

### Browser Sandbox & Exploits
- [Firefox vs Chromium Security - Madaidan](https://madaidans-insecurities.github.io/firefox-chromium.html)
- [Firefox Sandbox Escape CVE-2025-2857 - Help Net Security](https://www.helpnetsecurity.com/2025/03/28/critical-firefox-tor-browser-sandbox-escape-flaw-fixed-cve-2025-2857/)
- [Chrome Sandbox Escape Techniques - Theori](https://theori.io/blog/cleanly-escaping-the-chrome-sandbox/)
- [Browser Sandboxing Overview - misile00](https://misile00.github.io/notes/Browser-Sandboxing)
- [Chrome Sandbox Escape POCs - allpaca/chrome-sbx-db](https://github.com/allpaca/chrome-sbx-db)

### Session Management & MCP
- [MCP Session Management - GitHub Discussions](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/102)
- [Stateful MCP Server Sessions - CodeSignal](https://codesignal.com/learn/courses/developing-and-integrating-an-mcp-server-in-typescript/lessons/stateful-mcp-server-sessions/)
- [CONTINUITY: Session State Persistence - GitHub](https://github.com/duke-of-beans/CONTINUITY)

### Security Best Practices
- [Secure Remote Access Best Practices 2025 - Venn](https://www.venn.com/learn/secure-remote-access/secure-remote-access-best-practices/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [NIST Log Management Guide - SP 800-92](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-92.pdf)
- [Browser Security Best Practices 2026 - Venn](https://www.venn.com/learn/browser-security/browser-security-best-practices/)
- [REST API Security Best Practices - group107](https://group107.com/blog/rest-api-security-best-practices/)

---

**Document Status:** Complete  
**Last Updated:** 2026-04-13  
**Confidence Level:** High (based on official MCP specs, NIST guidelines, and active CVE databases)
