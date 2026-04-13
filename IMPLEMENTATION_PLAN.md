# RemoteBrowserMCP: Master Implementation Plan

**Version:** 1.0
**Date:** April 2026
**Status:** Ready for Execution

---

## Overview

This is the master implementation plan for RemoteBrowserMCP — a hosted browser-as-a-service platform that exposes browsers via MCP, provides VNC debugging, and tunnels into private networks via WireGuard. This plan synthesizes findings from 4 research streams and 4 detailed specification documents.

**Deliverable Index:**
| Document | Purpose |
|----------|---------|
| [CONCEPT_DOCUMENT.md](./CONCEPT_DOCUMENT.md) | Strategic vision, market analysis, business model |
| [spec-mcp-server.md](./spec-mcp-server.md) | MCP server code architecture, 25+ tool definitions, auth |
| [spec-infrastructure.md](./spec-infrastructure.md) | Hetzner setup, docker-compose, networking, orchestration |
| [spec-security-ops.md](./spec-security-ops.md) | Hardening, tenant isolation, incident response, compliance |
| [spec-launch-gtm.md](./spec-launch-gtm.md) | Beta program, pricing, content plan, 12-week launch timeline |

**Research Index:**
| Document | Purpose |
|----------|---------|
| [research-browser-mcp-landscape.md](./research-browser-mcp-landscape.md) | Existing MCP servers, remote browser services, gap analysis |
| [research-infrastructure.md](./research-infrastructure.md) | Containers, VNC/WebRTC, WireGuard, Hetzner, orchestration |
| [research-mcp-security.md](./research-mcp-security.md) | MCP transport, auth standards, multi-tenant security |
| [research-competitive-business.md](./research-competitive-business.md) | Competitors, pricing, market sizing, business model |

---

## 1. Executive Summary

### What We're Building
A hosted browser service on Hetzner that AI agents control via MCP, humans observe via VNC/WebRTC, and that can reach local services via a lightweight reverse tunnel CLI.

### Why Now
- AI agents market growing 46.3% CAGR ($10.91B in 2026 -> $52.62B by 2030)
- BrowserBase ($40M Series B) validated the market but lacks private network access & VNC
- MCP ecosystem at inflection point (Claude, Cursor, VS Code adoption)
- No competitor combines MCP-native + local tunnel + VNC

### Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **MCP SDK** | TypeScript (official `@modelcontextprotocol/sdk`) | Best Playwright integration, largest MCP ecosystem |
| **Browser Engine** | Chromium via Playwright | Superior multi-process isolation, industry standard |
| **Transport** | Streamable HTTP + SSE | MCP spec standard; OAuth-friendly, proxy-compatible |
| **Auth** | OAuth 2.0 Bearer Tokens (JWT) | Stateless, revokable, industry standard |
| **Streaming** | Neko (WebRTC) primary, noVNC fallback | 30-100ms latency vs 100-300ms for noVNC |
| **Tunnel** | Reverse tunnel CLI (`npx remotebrowser tunnel`) | Zero-install for users, SSH-based, exposes local ports to remote browser |
| **Hosting** | Hetzner AX41-NVMe bare metal | 25-40 concurrent users, €40/mo, 60% cheaper than alternatives |
| **Container** | Docker + cgroups (Kata optional for premium) | Proven, ~300-500MB per Chrome instance |
| **Orchestration** | systemd + custom Python (MVP), Nomad (scale) | Lightweight for MVP, scales to 50+ nodes |
| **Session Store** | Redis | Fast TTL, shared across workers |
| **Database** | PostgreSQL | Users, billing, audit logs |
| **Monitoring** | Prometheus + Grafana + Loki | Open-source, self-hostable |
| **CI/CD** | GitHub Actions | Standard, free for open-source |
| **Pricing** | Hybrid: base subscription + overage | Free/$29/$99/Custom tiers |

---

## 2. Architecture Overview

```
                    Internet
                       |
                  ┌────┴────┐
                  │  Caddy   │  (TLS termination, reverse proxy)
                  │  :443    │
                  └────┬────┘
                       |
          ┌────────────┼────────────┐
          |            |            |
    ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
    │ MCP Server│ │  API  │ │ Dashboard │
    │ /mcp      │ │ /api  │ │ /app      │
    │ (Node.js) │ │(FastAPI│ │ (Next.js) │
    └─────┬─────┘ └───┬───┘ └───────────┘
          |           |
    ┌─────┴───────────┴─────┐
    │   Session Orchestrator │  (Python, manages browser lifecycle)
    │   + Redis              │
    └─────┬──────────────────┘
          |
    ┌─────┴──────────────────────────────┐
    │  Per-Session Container (Docker)     │
    │  ┌─────────────────────────────┐   │
    │  │ Chromium + Playwright       │   │
    │  │ Xvfb (virtual display)      │   │
    │  │ Neko (WebRTC streaming)     │   │
    │  └─────────────────────────────┘   │
    │  Network namespace isolation       │
    │  cgroups (CPU/memory limits)       │
    └──────────────┬─────────────────────┘
                   |
    ┌──────────────┴──────────────────┐
    │ Reverse Tunnel (SSH)            │
    │ User runs:                      │
    │ npx remotebrowser tunnel :3000  │
    │ Browser reaches localhost:3000  │
    └─────────────────────────────────┘
```

### Component Responsibilities

| Component | Tech | Purpose |
|-----------|------|---------|
| **Caddy** | Go | TLS termination, routing, Let's Encrypt auto-renewal |
| **MCP Server** | TypeScript + Playwright | Exposes 25+ browser tools via MCP Streamable HTTP |
| **API Server** | Python FastAPI | User management, billing, session CRUD, dashboard API |
| **Dashboard** | Next.js | User-facing web UI for managing sessions, billing, VNC links |
| **Session Orchestrator** | Python | Creates/destroys browser containers, health checks, cleanup |
| **Redis** | Redis 7 | Session state, TTLs, pub/sub for events |
| **PostgreSQL** | PG 16 | Users, subscriptions, audit logs, usage records |
| **Browser Container** | Docker | Isolated Chromium + Xvfb + Neko per session |
| **Tunnel Server** | SSH (sshd) | Accepts reverse tunnels from user's CLI, routes into browser container |
| **Prometheus + Grafana** | Standard | Metrics, dashboards, alerting |

---

## 3. Phased Implementation Roadmap

### Phase 1: MVP Foundation (Weeks 1-4)

**Goal:** Single-server deployment with core MCP browser tools, basic auth, no VNC/WireGuard yet.

| Week | Workstream | Deliverables |
|------|-----------|-------------|
| 1 | **Infrastructure** | Hetzner AX41 provisioned, Ubuntu 24.04 hardened (per spec-security-ops.md), Docker installed, CI/CD pipeline |
| 1 | **MCP Server** | Project scaffold (TypeScript + MCP SDK), `navigate`, `screenshot`, `click`, `fill` tools working locally |
| 2 | **MCP Server** | Remaining tools: `wait`, `extract`, `execute_script`, `get_html`, `get_accessibility_tree` |
| 2 | **Infrastructure** | Docker image for browser container (Chromium + Xvfb + Playwright), docker-compose for local dev |
| 3 | **MCP Server** | Streamable HTTP transport, session management (create/destroy/list), Redis integration |
| 3 | **API Server** | FastAPI scaffold, user registration, API key generation, JWT auth |
| 4 | **Integration** | MCP server + API server + browser container working end-to-end on Hetzner |
| 4 | **Testing** | Integration tests with Claude Desktop, Cursor. Load test: 10 concurrent sessions |

**Exit Criteria:**
- MCP server responds to Claude Desktop with all core tools
- Sessions start in <2s, screenshots in <1s
- 10 concurrent sessions stable on single AX41
- Basic API key auth working

### Phase 2: VNC + Polish (Weeks 5-8)

**Goal:** Add VNC/WebRTC streaming, dashboard, billing, multi-tenant isolation.

| Week | Workstream | Deliverables |
|------|-----------|-------------|
| 5 | **VNC/Neko** | Neko WebRTC integrated into browser container, unique URL per session |
| 5 | **Dashboard** | Next.js app: login, session list, create session button, VNC link |
| 6 | **Billing** | Stripe integration: products/prices for Free/Starter/Pro, usage metering |
| 6 | **Security** | Container isolation hardened: seccomp, AppArmor, no-new-privileges, rootless Docker |
| 7 | **Multi-tenant** | Network namespace isolation, iptables rules, tenant isolation verification tests |
| 7 | **Monitoring** | Prometheus + Grafana deployed, key dashboards (sessions, CPU, memory, errors) |
| 8 | **Polish** | Error handling, reconnection logic, session timeout/cleanup, logging |
| 8 | **Docs** | Quickstart guide, API reference, Claude Desktop config example |

**Exit Criteria:**
- VNC URL works in browser, latency <200ms
- Stripe billing functional (metering browser hours)
- Tenant A cannot access Tenant B (verified by test harness)
- Documentation sufficient for self-service onboarding

### Phase 3: Reverse Tunnel + Beta Launch (Weeks 9-12)

**Goal:** Local service tunneling, beta program, first 100 users.

| Week | Workstream | Deliverables |
|------|-----------|-------------|
| 9 | **Tunnel Server** | SSH-based reverse tunnel server: per-session sshd, ephemeral keys, port routing into browser container |
| 9 | **Tunnel CLI** | `npx remotebrowser tunnel --port 3000 --session <id>` — zero-install Node.js CLI that opens reverse SSH tunnel |
| 10 | **Onboarding** | User onboarding flow: signup -> API key -> first session -> tunnel local app in <5 min |
| 10 | **Launch Prep** | Landing page, beta signup form, Discord community, status page |
| 11 | **Beta Launch** | Open beta to first 50 users (invite-only), feedback collection |
| 11 | **Ops** | On-call rotation, runbooks deployed, incident response procedures tested |
| 12 | **Iteration** | Bug fixes from beta feedback, performance tuning, capacity planning |
| 12 | **Scale Prep** | Evaluate Nomad for multi-node, plan Phase 4 |

**Exit Criteria:**
- Reverse tunnel works (`npx remotebrowser tunnel` exposes localhost to remote browser)
- 50+ beta users onboarded
- NPS >= 40 from beta cohort
- <0.5% error rate, 99.5% uptime

### Phase 4: Scale + GA (Weeks 13-20)

**Goal:** Multi-node cluster, enterprise features, general availability.

| Week | Workstream | Deliverables |
|------|-----------|-------------|
| 13-14 | **Multi-node** | Nomad cluster (3x AX41), session scheduling across nodes, Redis HA |
| 15-16 | **Enterprise** | SSO (SAML/OIDC), audit logs, custom session limits, SLA dashboard |
| 17-18 | **GA Launch** | Public launch, Product Hunt, HackerNews, content marketing push |
| 19-20 | **Optimize** | Cost optimization, auto-scaling logic, CDN for static assets |

---

## 4. Team & Roles

### MVP Team (3 people)

| Role | Responsibilities | Specs Owned |
|------|-----------------|-------------|
| **Backend/MCP Engineer** | MCP server, Playwright integration, session orchestrator | spec-mcp-server.md |
| **Infrastructure/DevOps** | Hetzner setup, Docker, networking, WireGuard, monitoring, CI/CD | spec-infrastructure.md, spec-security-ops.md |
| **Full-Stack/Product** | Dashboard, API server, Stripe billing, landing page, docs, GTM | spec-launch-gtm.md |

### Scale Team (add in Phase 4)

| Role | Responsibilities |
|------|-----------------|
| **Security Engineer** | SOC2 prep, penetration testing, incident response |
| **Growth/Community** | Content marketing, community management, partnerships |

---

## 5. Tech Stack Summary

```
Frontend:        Next.js 14 + Tailwind CSS
API Server:      Python 3.12 + FastAPI + SQLAlchemy
MCP Server:      TypeScript + @modelcontextprotocol/sdk + Playwright
Browser:         Chromium (via Playwright) + Xvfb
Streaming:       Neko (WebRTC) / noVNC (fallback)
Tunnel:          SSH reverse tunnel (npx remotebrowser tunnel)
Database:        PostgreSQL 16
Cache/Sessions:  Redis 7
Reverse Proxy:   Caddy 2
Containers:      Docker + docker-compose (MVP), Nomad (scale)
Monitoring:      Prometheus + Grafana + Loki
CI/CD:           GitHub Actions
Hosting:         Hetzner AX41-NVMe (Ubuntu 24.04)
Billing:         Stripe (subscriptions + usage-based)
Analytics:       PostHog (self-hosted or cloud)
```

---

## 6. Pricing Tiers (Launch)

| Tier | Price | Browser Hours | Concurrent Sessions | VNC | Tunnel | Overage |
|------|-------|--------------|--------------------|----|--------|---------|
| **Free** | $0/mo | 25 hrs | 1 | No | No | N/A |
| **Starter** | $29/mo | 50 hrs | 2 | Yes | Yes | $0.05/min |
| **Pro** | $99/mo | 200 hrs | 5 | Yes | Yes | $0.04/min |
| **Enterprise** | Custom | Custom | 20+ | Yes | Yes | Custom |

**Unit Economics:**
- Starter: 53% gross margin
- Pro: 71% gross margin
- Break-even: Q1 2027 at ~250 customers

---

## 7. Key Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| BrowserBase dominates MCP market | High | High | Own WireGuard + private network niche; MCP-native-first |
| Chrome memory leaks in long sessions | Medium | Medium | 24hr session TTL, periodic container restart, cgroups limits |
| Tunnel abuse (port scanning via tunnel) | Low | Medium | Ephemeral SSH keys per session, allowlisted ports only, auto-timeout |
| Cross-tenant data leak | Low | Critical | Network namespace isolation, iptables, automated test harness |
| Hetzner pricing changes | Medium | Medium | Lock 1-year contracts, multi-cloud fallback plan |
| Slow MCP ecosystem adoption | Medium | Medium | REST API fallback layer, focus on Claude/Cursor ecosystem |
| Single server SPOF | High (MVP) | Medium | Accept for MVP; HA cluster in Phase 4 |

---

## 8. Success Milestones

| Milestone | Target Date | Criteria |
|-----------|------------|---------|
| **MCP Server Working** | Week 4 | All core tools working with Claude Desktop |
| **VNC Streaming** | Week 5 | WebRTC URL shows live browser, <200ms latency |
| **Billing Live** | Week 6 | Stripe metering + subscription flows working |
| **Security Hardened** | Week 7 | Tenant isolation verified, seccomp/AppArmor active |
| **Tunnel Working** | Week 10 | `npx remotebrowser tunnel` exposes localhost to remote browser |
| **Beta Launch** | Week 11 | 50 users onboarded, feedback loop active |
| **100 Users** | Week 14 | 100 total users, 30%+ on paid plans |
| **$15K MRR** | Q4 2026 | Sustainable revenue, path to profitability visible |
| **GA Launch** | Week 18 | Public launch, multi-node, enterprise features |
| **$50K MRR** | Q1 2027 | Break-even, Series A optional |

---

## 9. Immediate Next Steps

1. **Set up repository** — Monorepo with `packages/mcp-server`, `packages/api`, `packages/dashboard`, `infra/`
2. **Provision Hetzner** — 1x CPX22 (dev) + 1x AX41 (staging), run provisioning script from spec-infrastructure.md
3. **Scaffold MCP server** — TypeScript project with MCP SDK, implement `navigate` + `screenshot` as proof of concept
4. **Validate with Claude Desktop** — Confirm MCP connection works end-to-end before building more tools
5. **Set up CI/CD** — GitHub Actions for Docker build + deploy to Hetzner
6. **Begin sprint 1** — Follow Phase 1 week-by-week plan above

---

## Appendix: File Index

```
/private/var/www/remotebrowsermcp/
├── IMPLEMENTATION_PLAN.md          ← This document (master plan)
├── CONCEPT_DOCUMENT.md             ← Strategic vision & business model
├── research-browser-mcp-landscape.md   ← Browser MCP ecosystem research
├── research-infrastructure.md          ← Infrastructure options research
├── research-mcp-security.md            ← MCP protocol & security research
├── research-competitive-business.md    ← Competitive & business analysis
├── spec-mcp-server.md                  ← MCP server implementation spec
├── spec-infrastructure.md              ← Infrastructure deployment spec
├── spec-security-ops.md                ← Security & operations playbook
└── spec-launch-gtm.md                  ← Launch & GTM execution plan
```

---

**Document Status:** Complete
**Last Updated:** April 2026
**Next Review:** After Week 4 (Phase 1 completion)
