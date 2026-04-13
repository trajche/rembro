# RemoteBrowserMCP: Hosted Browser Service for AI Agents
## Concept Document & Strategic Plan

**Version:** 1.0  
**Date:** April 2026  
**Status:** Ready for Development Phase

---

## Executive Summary

RemoteBrowserMCP is a hosted browser-as-a-service platform designed from the ground up for AI agents and developers. We combine three proven technologies—Model Context Protocol (MCP), WireGuard VPN tunnels, and VNC remote desktop—to solve critical gaps in the current browser automation landscape.

**The Problem:** Today's AI developers and QA teams face fragmented solutions:
- Cloud browser services (BrowserBase, Browserless) can't test internal/staging networks
- No real-time debugging capability for failing automations
- MCP integration is bolted-on, not native
- Self-hosting is complex; managed hosting is expensive or lock-in

**Our Solution:** RemoteBrowserMCP combines:
1. **MCP-Native Architecture** — Browser control via Model Context Protocol, not APIs
2. **WireGuard Tunneling** — Test internal apps, staging DBs, local services securely
3. **VNC Debugging** — Real-time browser visibility + human intervention
4. **Hetzner Cost Advantage** — 60% cheaper infrastructure than competitors
5. **Developer-First Pricing** — Free tier + freemium + generous Pro tier

**Market Opportunity:** The AI agents market is growing at 46.3% CAGR toward $52.62B by 2030. Browser automation for agents alone represents a $1.6-2.2B addressable market. We target a 5-10% share within 5 years ($50-100M ARR).

**Timeline:** MVP launch in Q3 2026 (Q2 if accelerated). Beta customers by Q4 2026. Scale phase Q1 2027+.

---

## 1. Product Vision

### 1.1 Core Concept

**RemoteBrowserMCP = Browser + MCP + WireGuard + VNC**

A production-grade browser service hosted on Hetzner infrastructure that:
1. Runs headless/headed browsers in containers
2. Exposes full browser control via the MCP protocol (not APIs)
3. Allows tunneling into customer private networks via WireGuard
4. Provides human-accessible VNC URLs for real-time debugging
5. Integrates seamlessly with Claude, Cursor, VS Code, and other MCP clients
6. Can be self-hosted on customer infrastructure (future)

### 1.2 Core Use Cases

**Primary (MVP):**
1. **AI Agent Testing** — Automate web interactions with Claude + MCP
   - "I need my Claude agent to fill out this form and test it"
   - Access via MCP server in Claude Desktop/Cursor
   
2. **Internal App Testing** — Test against private/staging networks
   - "I need to test my staging app that's only accessible via VPN"
   - Deploy browser on our servers; tunnel to customer's network via WireGuard

3. **Debugging Automation** — Watch & fix failing workflows
   - "My automation broke; let me see what's happening in real-time"
   - VNC URL for live browser visibility + intervention

4. **Batch Web Scraping + Reasoning** — Long-running AI-driven scraping
   - Sessions up to 24 hours for complex workflows
   - CAPTCHA handling + bot detection evasion included

**Secondary (Post-MVP):**
5. **QA/Testing Automation** — AI-driven test generation and execution
6. **Development & Local Testing** — VNC to test local/docker apps
7. **Compliance & Data Sovereignty** — Self-hosted option for regulated industries

### 1.3 Success Criteria (MVP)

✅ **Technical:**
- MCP server fully implements browser tools (screenshot, navigate, click, fill, extract)
- WireGuard tunneling works for accessing localhost + private subnets
- VNC URLs are reliable and low-latency (<500ms)
- Session persistence across reconnects
- Support for multiple concurrent sessions per user

✅ **Product:**
- Free tier is compelling (25 hrs/month + basic features)
- Starter plan is sticky (50 hrs/month for $29)
- Pro plan achieves 60%+ gross margin
- Onboarding takes <5 minutes for first browser session

✅ **Market:**
- 100+ beta users by end of Q4 2026
- 50%+ of beta users convert to paid by Q1 2027
- NPS score ≥ 40 (product-market fit territory)
- Zero paid marketing spend; 100% organic growth

---

## 2. Market Opportunity

### 2.1 TAM & Market Sizing

| Metric | Value | Rationale |
|--------|-------|-----------|
| **Global AI Agents Market (2026)** | $10.91B | Confirmed from McKinsey, GVR, F&M |
| **Browser Automation Subset** | $1.6-2.2B | Estimated 15-20% of AI agents spend |
| **Hosted Services Addressable** | $640M-880M | 40% of automation (rest self-hosted) |
| **Realistic 5-Year TAM** | $50-100M ARR | 5-10% of addressable market |

**Segment Breakdown:**
- **Indie Developers & Students:** 10,000+ (5% paid) → Free tier brand-building
- **Startups (Seed-Series B):** ~10,000 companies → 500-1,000 at $99/mo avg = $6-12M ARR
- **Mid-market (Series C+):** ~1,000 companies → 100-150 at $500/mo avg = $6-9M ARR
- **Enterprise:** ~500 large organizations → 25-50 at $5k/mo = $1.5-3M ARR

**Conservative Year 3 Target:** 200-500 customers, $2-5M ARR

### 2.2 Market Drivers

**Macro Trends:**
1. **AI Agents Explosion** (62% of orgs experimenting with agents per McKinsey)
2. **MCP Adoption** (Anthropic pushing MCP as standard; Claude Desktop, VS Code, Cursor integrations)
3. **Remote Work** (need to test internal/private networks securely)
4. **Cost Pressure** (companies seeking 60% cheaper alternatives to expensive QA tools)
5. **Browser Automation Gaps** (Playwright/Puppeteer still need self-hosting or cloud orchestration)

**Market Timing:**
- BrowserBase Series B (2024) validated the market
- Steel.dev's 100 hrs/mo free tier shows strong demand
- MCP ecosystem (Claude, Cursor, etc.) is at inflection point
- WireGuard is mature but underutilized in browser automation

---

## 3. Competitive Positioning

### 3.1 Competitive Landscape Summary

| Feature | BrowserBase | Browserless | Steel.dev | **RemoteBrowserMCP** |
|---------|---|---|---|---|
| **Pricing** | $20-225/mo | Free-scaled | Free-100hrs, paid | $0-$99/mo |
| **MCP Native** | ✅ Bolt-on | ❌ No | ❌ No | ✅ **Core Design** |
| **Private Network Tunneling** | ❌ No | ❌ No | ❌ No | ✅ **WireGuard** |
| **VNC Debugging** | ❌ No | ❌ No | ❌ No | ✅ **Yes** |
| **Self-Host Option** | ❌ No | ✅ (SSPL) | ✅ (OSS) | ✅ **Planned** |
| **Enterprise Funding** | $40M+ | Undisclosed | Undisclosed | Bootstrapped |
| **Target Users** | Enterprise QA | Flexible | Devs/Startups | **Devs/AI Engineers** |

### 3.2 Differentiation Strategy

**1. MCP-Native (Not API-First)**
- **Why:** Emerging standard for AI tooling; seamless Claude/Cursor/VS Code integration
- **How:** Build MCP protocol as core abstraction, not a wrapper over REST API
- **Advantage:** First-mover in MCP browser services; avoids API fragmentation
- **Positioning:** "The browser service built for Claude and modern AI tools"

**2. WireGuard Tunneling (Unique)**
- **Why:** Only browser service that can test internal/staging networks securely
- **How:** Deploy WireGuard clients in browser containers; customers add route to our servers
- **Advantage:** Solves real pain point; competitive moat (technically complex)
- **Use Case:** "Test your staging API without exposing it to the internet"

**3. VNC Debugging (Overlooked)**
- **Why:** Automation debugging is painful; no one provides real-time browser visibility
- **How:** Attach VNC server to browser container; expose via secure URLs
- **Advantage:** Dramatically speeds up debugging; enables human intervention
- **Use Case:** "Watch your AI agent in real-time and fix issues on the fly"

**4. Developer Economics**
- **Why:** Other services focus on enterprise; we optimize for devs
- **How:** Generous free tier (25 hrs/mo), low Starter pricing ($29/mo), open-source core
- **Advantage:** Network effects, community, organic growth
- **Positioning:** "The most developer-friendly browser service"

### 3.3 Positioning Statement

*RemoteBrowserMCP is the MCP-native browser service for AI developers who need to test internal apps, debug automations in real-time, and integrate seamlessly with Claude and modern development tools—without the enterprise price tag.*

---

## 4. Product & Technical Architecture

### 4.1 MVP Feature Set

**Core MCP Browser Tools:**
- `navigate(url)` — Go to a webpage
- `screenshot()` — Capture visible page
- `click(selector)` — Click DOM element
- `fill(selector, text)` — Fill text input
- `wait(selector, timeout)` — Wait for element to appear
- `extract(selector)` — Extract text from element(s)
- `execute_script(code)` — Run arbitrary JavaScript
- `get_html()` — Return full page HTML

**Session Management:**
- Create/manage concurrent browser sessions
- Session persistence (cookies, local storage)
- Timeout-based cleanup
- Reconnect without losing state

**WireGuard Networking (MVP Phase 2):**
- Customer provisions WireGuard config file
- Browser container auto-connects to customer's WireGuard network
- Browser can reach `localhost`, private subnets, staging APIs
- Firewall rules: browser initiates outbound; no inbound from customer network

**VNC Debugging:**
- VNC server attached to each browser session
- Secure URL via token-based access
- Works with any VNC client (browser-based viewer available)
- Real-time keyboard/mouse input for intervention

**Infrastructure:**
- Containerized browsers (Chromium in Docker)
- Multi-user isolation via Linux cgroups/namespaces
- Auto-scaling (add servers as demand grows)
- Monitoring + logging (structured logs, Prometheus metrics)

### 4.2 Technical Stack (Proposed)

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Browser** | Chromium (Puppeteer/Playwright) | Industry standard; extensive features |
| **Container** | Docker + rootless | Security; multi-user isolation |
| **Orchestration** | systemd + custom supervisor | Lightweight; predictable for single-tenant |
| **MCP Server** | Python/Node.js (MCP SDK) | Mature; well-documented |
| **VNC** | TigerVNC or noVNC | Lightweight; web-accessible option |
| **Networking** | WireGuard | Modern; lightweight; secure |
| **Infrastructure** | Hetzner (CPX22/CCX23) | 60% cheaper than competitors |
| **API Tier** | FastAPI/Express (internal) | REST API for web dashboard |
| **Database** | PostgreSQL | Session state, billing, user management |
| **Monitoring** | Prometheus + Loki + Grafana | Open-source; self-hostable |

### 4.3 Deployment Model (MVP)

**Phase 1: Hetzner-Hosted SaaS**
- Single region (Germany or US-East)
- Shared infrastructure (multi-tenant)
- Managed for customers (no self-hosting yet)
- Pricing: Free tier + subscription tiers

**Phase 2: Multi-Region + Self-Hosted**
- EU, US, APAC regions
- Self-hosted option (open-source core + commercial support)
- Compliance (GDPR, SOC2)

---

## 5. Business Model & Pricing

### 5.1 Pricing Strategy (Recommended)

**Hybrid Model: Base Subscription + Overage**

| Tier | Monthly Fee | Included Hours | Concurrent Sessions | Overage | VNC Access | WireGuard |
|------|---|---|---|---|---|---|
| **Free** | $0 | 25 hrs | 1 | N/A | ❌ | ❌ |
| **Starter** | $29 | 50 hrs | 2 | $0.05/min | ✅ | ❌ |
| **Pro** | $99 | 200 hrs | 5 | $0.04/min | ✅ | ✅ |
| **Enterprise** | Custom | Custom | 20+ | Custom | ✅ | ✅ |

**Rationale:**
- **Free tier:** Attracts developers; builds community; feeds Pro conversion funnel
- **Starter:** Entry point for small teams; low CAC payback
- **Pro:** Sticky segment; supports WireGuard + VNC; strong margins
- **Enterprise:** Custom deals for $5k+/mo contracts; white-glove support

### 5.2 Unit Economics

**Cost Structure (Per Browser Session):**
- Hetzner server: €12.49/mo for 4vCPU/16GB RAM
- Capacity: ~2.5 concurrent sessions per server (safe)
- **COGS per session:** €5/month (~$5.44)

**Starter Plan ($29/mo):**
- Typical: 2.5 concurrent sessions
- COGS: 2.5 × $5.44 = $13.60
- **Gross Margin:** ($29 - $13.60) / $29 = **53%**
- After ops/support (10%): **Net Margin ≈ 43%**

**Pro Plan ($99/mo):**
- Typical: 5 concurrent sessions + WireGuard overhead
- COGS: 5 × $5.44 + $1.50 (infra/ops) = $28.70
- **Gross Margin:** ($99 - $28.70) / $99 = **71%**
- After ops/support (10%): **Net Margin ≈ 61%**

**LTV Analysis:**
- Starter LTV (assume 85% monthly retention): $29 / (1-0.85) × margin ≈ $200 lifetime value
- Pro LTV (assume 90% retention): $61 / (1-0.90) × margin ≈ $610 lifetime value
- **Implication:** Focus on Pro + Enterprise; Free tier is for ecosystem/brand-building

---

## 6. Go-to-Market Strategy

### 6.1 Phase 1: MVP Launch (Q3-Q4 2026)

**Launch Targets:**
1. **AI Developer Community** (50% of initial users)
   - Claude + MCP ecosystem (Anthropic partnerships)
   - Cursor + VS Code extension communities
   - Product Hunt, HackerNews, indie hacker forums

2. **Internal Tools Builders** (30%)
   - Retool, Budibase, n8n users
   - Need to test apps against private networks

3. **QA/Testing Teams** (20%)
   - Transitioning from Playwright/Puppeteer to cloud
   - Looking for AI-first testing platforms

**Acquisition Channels:**
- **Content Marketing:** Blog posts on "MCP for Browser Automation", "Testing Internal Apps Securely"
- **Community:** Contribute MCP servers; participate in Anthropic/Claude community
- **Direct:** Outreach to early MCP adopters, AI agent builders
- **Partnerships:** Anthropic, Anthropic fund companies, Cursor ecosystem

**Success Metrics (End of Q4 2026):**
- 100+ beta users
- 30%+ conversion to paid (Free → Starter/Pro)
- NPS ≥ 40
- $10-20K MRR
- Zero paid marketing spend

### 6.2 Phase 2: Feature Expansion (Q1-Q2 2027)

**New Features:**
- WireGuard private network tunneling (differentiator launch)
- VNC debugging URLs + improvements
- API tier (for non-MCP integrations)
- Multi-region support (EU, US)

**Market Expansion:**
- QA platforms (Momentic, Shortest integrations)
- Testing frameworks (Cypress, Playwright ecosystem)
- Enterprise pilots (SOC2, compliance features)

**Success Metrics:**
- 300-500 total customers
- $50-100K MRR
- Enterprise deals (2-3 at $5k+/mo)
- 70%+ Pro/Enterprise customer base

### 6.3 Phase 3: Scale (Q3 2027+)

**New Markets:**
- Self-hosted option (open-source core)
- Enterprise support & SLAs
- Industry-specific features (healthcare, finance)

**Growth:**
- Target: 1000+ customers by end of 2027
- $500K+ MRR
- Series A funding if needed for scale

---

## 7. Implementation Roadmap

### 7.1 MVP Build (8-12 weeks)

**Sprint 1-2: Foundation (Weeks 1-4)**
- [ ] Set up Hetzner infrastructure (base image, CI/CD)
- [ ] Implement MCP server skeleton (browser control tools)
- [ ] Containerized Chromium setup
- [ ] Session management (create/destroy/list)
- [ ] Basic auth + API keys

**Sprint 3-4: MCP Integration (Weeks 5-8)**
- [ ] Implement all MCP browser tools (screenshot, navigate, click, fill, extract, etc.)
- [ ] Integration testing with Claude Desktop / Cursor
- [ ] Error handling + timeouts
- [ ] Performance optimization (session start time <2s)
- [ ] Documentation + examples

**Sprint 5-6: Polish & Hardening (Weeks 9-12)**
- [ ] Security audit (container isolation, credential handling)
- [ ] Load testing (simulate 100 concurrent users)
- [ ] Logging + monitoring setup
- [ ] Billing system (Stripe integration)
- [ ] Dashboard (basic user management, session history)
- [ ] Beta signup + onboarding

**Parallel: Infrastructure & Ops**
- [ ] Hetzner account setup + automation
- [ ] Docker build system + registry
- [ ] Deployment pipeline (GitHub Actions)
- [ ] Monitoring (Prometheus + Grafana)
- [ ] Runbook + on-call setup

### 7.2 Phase 2: Differentiation Features (Q1 2027)

**WireGuard Implementation (4-6 weeks)**
- [ ] WireGuard server setup + key generation
- [ ] Client integration in browser containers
- [ ] Customer onboarding flow (config file generation)
- [ ] Testing against private networks
- [ ] Documentation + security model

**VNC Debugging (3-4 weeks)**
- [ ] noVNC server integration
- [ ] Secure URL generation + token-based access
- [ ] Performance optimization (latency)
- [ ] Testing with VNC clients

### 7.3 Success Gating

| Gate | Success Criteria | Owner |
|------|---|---|
| **MVP Ready** | All core MCP tools working; NPS ≥ 40 from beta | Engineering |
| **Product-Market Fit** | 30%+ Free→Paid conversion; retention ≥ 85% | Product |
| **Unit Economics** | Pro tier ≥ 60% gross margin | Finance |
| **Go-to-Market** | 100 beta users, $10K+ MRR, zero paid marketing | Growth |
| **Scale Ready** | Enterprise SOC2, multi-region, 500+ customers | Ops |

---

## 8. Investment Requirements

### 8.1 Funding Needs (Pre-Launch)

| Item | Cost | Notes |
|------|------|-------|
| **Engineering (3 FTE, 4 months)** | $150K | Co-founders likely; cost is opportunity |
| **Hetzner Infrastructure** | $5K | 4-month runway, ~20 servers at €7.99-12.49/mo |
| **Tools & Services** | $3K | GitHub, Stripe, Sentry, domain, etc. |
| **Marketing & Launch** | $5K | Content, community, no paid ads yet |
| **Legal & Compliance** | $5K | Terms of service, privacy policy, liability |
| **Contingency** | $7K | Buffer for unknowns |
| **TOTAL** | **$175K** | Bootstrappable or seed round |

### 8.2 Path to Profitability

| Metric | Q4 2026 | Q1 2027 | Q2 2027 | Q3 2027 |
|--------|---|---|---|---|
| **Customers** | 100 | 250 | 500 | 1000 |
| **MRR** | $15K | $50K | $150K | $350K |
| **Operating Costs** | $30K | $35K | $50K | $80K |
| **Gross Profit** | ($15K) | +$15K | +$100K | +$270K |
| **Profitability** | Negative | Break-even | Profitable | Highly profitable |

**Key Insight:** Path to profitability by Q1-Q2 2027. Series A only needed if targeting aggressive expansion.

---

## 9. Risk Assessment & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| **BrowserBase dominates MCP space** | High | High | Differentiate on WireGuard + private network; own niche (AI testing) |
| **MCP adoption slower than expected** | Medium | Medium | Build REST API layer as fallback; integrate with Cursor, VS Code |
| **Hetzner price increases** | Medium | Medium | Lock in 1-year commitments; multi-cloud strategy (AWS fallback) |
| **WireGuard security concerns** | Low | High | Engage security firm for audit; documentation + compliance |
| **Customer churn on Free tier** | High | Low | Expected; focus on Starter→Pro retention (aim for 70%+) |
| **Chicken-egg MCP ecosystem** | Medium | Medium | Invest in MCP adoption; partner with Anthropic early |

---

## 10. Success Metrics & KPIs

### 10.1 Product Metrics

| KPI | Target (Q4 2026) | Target (Q2 2027) |
|-----|---|---|
| **Session Start Time** | <2s | <1.5s |
| **VNC Latency** | <500ms | <300ms |
| **Error Rate** | <0.5% | <0.1% |
| **Uptime SLA** | 99.5% | 99.9% |
| **NPS Score** | ≥40 | ≥50 |

### 10.2 Business Metrics

| KPI | Target (Q4 2026) | Target (Q2 2027) |
|-----|---|---|
| **Total Customers** | 100 | 500 |
| **MRR** | $15K | $150K |
| **Free→Paid Conversion** | 30% | 35% |
| **Starter→Pro Upsell** | 20% | 25% |
| **Monthly Churn Rate** | 10% | 5% |
| **Gross Margin** | 60% | 65% |
| **CAC Payback Period** | 8 months | 5 months |

### 10.3 Market Metrics

| KPI | Target (End 2027) |
|-----|---|
| **Market Share (Addressable)** | 1-2% |
| **Customer Satisfaction** | NPS ≥50 |
| **Team Size** | 5-8 people |
| **ARR** | $4M+ |

---

## 11. Conclusion

RemoteBrowserMCP addresses a real and growing market—AI agents that need browser access—with differentiated technology (MCP-native, WireGuard, VNC) and developer-friendly positioning. We have a clear path to profitability, defensible competitive advantages, and a multi-billion-dollar market tailwind.

**Next Steps:**
1. ✅ Complete this concept document
2. **Validate:** Customer interviews with AI engineers and QA teams
3. **Prototype:** Proof-of-concept MCP server + basic browser session management
4. **Build:** Full MVP with all core features
5. **Launch:** Beta access to early adopters (target Q3 2026)
6. **Scale:** Expand to Pro/Enterprise segment with WireGuard differentiation

**Timeline:** MVP launch Q3 2026, product-market fit Q4 2026, scale to $4M+ ARR by end of 2027.

---

## Appendix: References & Research

- [Full Competitive Analysis](./research-competitive-business.md)
- [Infrastructure Research](./research-infrastructure.md)
- [MCP Protocol Analysis](./research-mcp-integration.md)
- [Browser Solutions Research](./research-browser-solutions.md)

---

**Document Status:** ✅ Complete  
**Last Updated:** April 2026  
**Next Review:** Quarterly or after major milestones
