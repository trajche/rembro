# CLAUDE.md

## Project Overview

Rembro is a remote browser MCP server. It runs real browsers (Chromium/Firefox/WebKit) inside a Docker container with Xvfb + x11vnc, exposing browser automation via 60 MCP tools over Streamable HTTP. Users watch the browser live through noVNC in their web browser.

## Key Files

- `mcp-server/src/server.ts` — The entire server: session management, MCP tools, REST API, VNC proxy, dashboard. Single-file architecture.
- `docker/browser/Dockerfile` — Container image: Node 20, Playwright browsers, Xvfb, x11vnc, noVNC, tesseract-ocr, SSH server.
- `docker-compose.yml` — Docker Compose config: browser service + Caddy reverse proxy.
- `cli/rembro` — Bash CLI for SSH tunneling and session management.
- `Caddyfile` — Caddy config for auto-HTTPS reverse proxy.

## Build & Run

```bash
# Build TypeScript
cd mcp-server && npm run build

# Dev mode (requires Xvfb, x11vnc, Playwright browsers installed locally)
cd mcp-server && npm run dev

# Docker (production)
docker compose up -d --build
```

## Architecture Notes

- Each browser session gets its own Xvfb display (`:100`, `:101`, ...) and x11vnc instance on a unique port.
- MCP sessions auto-create a browser session on first connection. When the MCP transport closes, the browser session is destroyed.
- Sessions have a TTL (default 30 min inactivity). A cleanup interval runs every 60s.
- The VNC WebSocket proxy bridges browser WebSocket connections to the x11vnc TCP port.
- `destroyBrowserSession()` uses SIGKILL and a 5s timeout on `browser.close()` to prevent hangs.

## Code Conventions

- All MCP tool handlers follow the pattern: wrap in try/catch, return `{ isError: true }` on failure.
- Zod schemas define tool parameters inline in `server.tool()` calls.
- Console/network/error logs go through the structured `SessionLogStore` ring buffer (1000 entries max).
- `getSession()` updates `lastActivity` on every call for TTL tracking.

## Testing

There are no automated tests. Test by:
1. Building: `cd mcp-server && npm run build`
2. Deploying: `docker compose up -d --build`
3. Checking health: `curl https://rembro.digitalno.de/health`
4. Using the MCP tools via Claude Code or the dashboard.

## Deployment

```bash
# On the Hetzner server
cd /var/www/remotebrowsermcp
git pull
docker compose up -d --build
```

The deploy script `deploy.sh` may also be used. Caddy handles HTTPS automatically via Let's Encrypt.
