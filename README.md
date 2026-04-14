# Rembro - Remote Browser MCP

Remote browser sessions controlled by AI agents via MCP, with live VNC viewing and local service tunneling.

**Live server:** https://rembro.digitalno.de

## What is this?

Rembro gives AI agents (Claude Code, custom MCP clients) a real browser running on a remote server. The agent can navigate, click, fill forms, take screenshots, extract text, and more — while you watch live via VNC in your browser.

**→ See [API.md](./API.md) for full API reference with payload examples.**

It's useful for:
- **Testing web apps** — point the AI at your local dev server through an SSH tunnel
- **Web scraping/research** — let the AI browse the web and extract information
- **UI automation** — automate complex multi-step browser workflows
- **Debugging** — watch what the AI sees in real-time via VNC, inspect console logs and network requests

## Quick Start

### 1. Connect AI via MCP

Add to your `.mcp.json` (Claude Code) or MCP config:

```json
{
  "mcpServers": {
    "remotebrowser": {
      "type": "http",
      "url": "https://rembro.digitalno.de/mcp"
    }
  }
}
```

Then ask Claude to navigate, click, screenshot, fill forms — it controls the remote browser. A browser session is created automatically when the MCP connection is established.

### 2. Expose a local service (optional)

```bash
# Install the CLI
curl -sL https://rembro.digitalno.de/cli -o /usr/local/bin/rembro && chmod +x /usr/local/bin/rembro

# Start your local app, then expose it
rembro expose 3000
```

The CLI creates an SSH reverse tunnel so the remote browser can reach your `localhost:3000`. It prints the VNC URL where you can watch the browser live.

### 3. Web Dashboard

Open https://rembro.digitalno.de to view active sessions, create/kill sessions, and get VNC links.

## Architecture

```
Your Machine                          Hetzner Server (rembro.digitalno.de)
┌──────────────┐                      ┌──────────────────────────┐
│ localhost:3000│                      │ Docker Container          │
│              │   SSH reverse tunnel  │ ┌──────────────────────┐ │
│ rembro CLI   │◄────────────────────►│ │ Chromium / Firefox /  │ │
│              │                      │ │ WebKit browser        │ │
└──────────────┘                      │ │ → navigates to        │ │
                                      │ │   localhost:3000      │ │
       You                            │ ├──────────────────────┤ │
┌──────────────┐                      │ │ VNC (x11vnc + Xvfb)  │ │
│ Browser      │   WebSocket (VNC)    │ │ → watch live at       │ │
│ VNC viewer   │◄────────────────────►│ │   /vnc/<session-id>   │ │
└──────────────┘                      │ └──────────────────────┘ │
                                      │                          │
       AI Agent                       │ MCP Server (Express)     │
┌──────────────┐   Streamable HTTP    │ → 43 tools for browser   │
│ Claude Code  │◄────────────────────►│   automation             │
│ (MCP client) │                      │                          │
└──────────────┘                      └──────────────────────────┘
```

## MCP Tools (60 total)

### Session Management
| Tool | Description |
|------|-------------|
| `create_session` | Create a browser session with config (browser type, viewport, proxy, locale, etc.) |
| `destroy_session` | Kill a session and all its processes |
| `list_sessions` | List all active sessions |
| `get_session_info` | Get session details including VNC URL |

### Browser Configuration
| Tool | Description |
|------|-------------|
| `list_viewport_presets` | List available viewport presets (iPhone, iPad, Pixel, desktop sizes) |
| `set_viewport` | Change viewport dimensions mid-session |

### Navigation
| Tool | Description |
|------|-------------|
| `navigate` | Go to a URL |
| `go_back` / `go_forward` | Browser history navigation |
| `reload` | Reload the current page |
| `get_current_url` | Get current URL and page title |

### Interaction
| Tool | Description |
|------|-------------|
| `click` | Click an element by CSS selector (iframe-aware) |
| `click_at_coordinates` | Click at pixel coordinates (x, y) |
| `fill` | Fill an input field (iframe-aware) |
| `type` | Type text via keyboard |
| `press_key` | Press a key (Enter, Tab, Escape, etc.) |
| `hover` | Hover over an element (iframe-aware) |
| `select_option` | Select a dropdown option (iframe-aware) |
| `drag_and_drop` | Drag from one element to another |

### Content Extraction
| Tool | Description |
|------|-------------|
| `screenshot` | Take a screenshot (full page, element, or with OCR text extraction) |
| `ocr` | Extract text from the page via OCR with optional word-level bounding boxes |
| `get_accessibility_tree` | Get the accessibility tree (semantic page structure for AI agents) |
| `get_html` | Get page or element HTML (iframe-aware) |
| `get_text` | Get text content of page or element (iframe-aware) |
| `get_attribute` | Get an element's attribute value (iframe-aware) |
| `save_pdf` | Generate a PDF of the current page (Chromium only, via CDP) |

### JavaScript
| Tool | Description |
|------|-------------|
| `execute_script` | Run JavaScript in the page context |

### Debugging & Logging
| Tool | Description |
|------|-------------|
| `get_logs` | Query all logs with filters (category, level, cursor-based pagination) |
| `get_console_logs` | Get browser console output (backward-compatible) |
| `get_errors` | Get all errors (JS exceptions, console errors, HTTP 4xx/5xx) |
| `get_network_log` | Get network requests/responses with URL and status filters |

### Network Recording
| Tool | Description |
|------|-------------|
| `start_har_recording` | Start recording all network traffic for HAR export |
| `stop_har_recording` | Stop recording and return HAR 1.2 data (full or summary) |
| `get_response_body` | Wait for and capture a specific response body by URL pattern |

### Network Interception
| Tool | Description |
|------|-------------|
| `mock_route` | Intercept requests matching a glob and return a custom response |
| `block_route` | Block/abort requests matching a glob pattern |
| `list_routes` | List active route interceptions |
| `clear_routes` | Remove all route interceptions |

### File Downloads
| Tool | Description |
|------|-------------|
| `wait_for_download` | Trigger an action and capture the resulting download |
| `get_downloads` | List all completed downloads for this session |
| `get_download_content` | Get a downloaded file's content (base64 or text) |

### iframes
| Tool | Description |
|------|-------------|
| `list_frames` | List all frames in the page (name, URL, main/detached status) |
| `switch_frame` | Set active frame for subsequent interaction tools (omit to return to main) |
| `frame_click` | Click inside a specific iframe |
| `frame_fill` | Fill an input inside a specific iframe |
| `frame_get_text` | Get text content from inside a specific iframe |
| `frame_get_html` | Get HTML from inside a specific iframe |

### Waiting
| Tool | Description |
|------|-------------|
| `wait_for_selector` | Wait for an element to appear |
| `wait` | Simple delay (up to 30s) |

### Multi-Tab
| Tool | Description |
|------|-------------|
| `list_pages` | List all open tabs with URLs and titles |
| `new_page` | Open a new tab, optionally navigating to a URL |
| `switch_page` | Switch the active tab by index |
| `close_page` | Close a tab |

### Cookies & Storage
| Tool | Description |
|------|-------------|
| `get_cookies` | Get cookies, optionally filtered by URL |
| `set_cookies` | Set cookies with full options (domain, path, httpOnly, secure, sameSite) |
| `clear_cookies` | Clear all cookies |
| `get_storage` | Read localStorage or sessionStorage |
| `set_storage` | Write to localStorage or sessionStorage |

### Auth State
| Tool | Description |
|------|-------------|
| `save_auth_state` | Export full auth state (cookies + storage) as JSON |
| `restore_auth_state` | Restore auth state into a fresh browser context |

## Session Configuration

`create_session` accepts these options:

```json
{
  "browser": "chromium | firefox | webkit",
  "viewport_preset": "iphone-14 | iphone-14-pro | pixel-7 | ipad-pro | desktop-hd | desktop-fhd | desktop-2k | desktop-4k",
  "viewport_width": 1920,
  "viewport_height": 1080,
  "locale": "en-US",
  "timezoneId": "America/New_York",
  "colorScheme": "dark",
  "userAgent": "custom user agent string",
  "geolocation": { "latitude": 40.7128, "longitude": -74.0060 },
  "proxy": { "server": "http://proxy:8080" }
}
```

### Viewport Presets

| Preset | Resolution | Type |
|--------|-----------|------|
| `iphone-14` | 390x844 | Mobile |
| `iphone-14-pro` | 393x852 | Mobile |
| `pixel-7` | 412x915 | Mobile |
| `ipad-pro` | 1024x1366 | Tablet |
| `desktop-hd` | 1280x720 (default) | Desktop |
| `desktop-fhd` | 1920x1080 | Desktop |
| `desktop-2k` | 2560x1440 | Desktop |
| `desktop-4k` | 3840x2160 | Desktop |

## CLI Commands

```
rembro expose <port>         Expose a local port to the remote browser
rembro expose 8080 -r 3000   Map local:8080 to remote:3000
rembro expose 3000 -s <id>   Attach to existing session
rembro session               Create a session (no tunnel)
rembro sessions              List active sessions
rembro kill <id>             Kill a session
rembro setup                 Download tunnel key
```

## REST API

```bash
# Create a session (with options)
curl -X POST https://rembro.digitalno.de/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"browser": "firefox"}'

# List sessions
curl https://rembro.digitalno.de/api/sessions

# Kill a session
curl -X DELETE https://rembro.digitalno.de/api/sessions/<id>

# Kill all sessions
curl -X DELETE https://rembro.digitalno.de/api/sessions

# Stream logs (SSE)
curl -N https://rembro.digitalno.de/api/sessions/<id>/logs/stream

# Health check
curl https://rembro.digitalno.de/health
```

## Features by Sprint

### Sprint 1
Core browser automation, multi-browser support (Chromium/Firefox/WebKit), 8 viewport presets, accessibility tree, OCR with bounding boxes, click-at-coordinates, cookies/storage management, multi-tab, auth state save/restore, structured logging with cursor pagination, network monitoring, session auto-cleanup (30min TTL).

### Sprint 2
File download capture, HAR recording and export, network request/response interception and mocking, iframe support (list, switch, interact), PDF generation via CDP.
```

## Self-Hosting

### Prerequisites
- Docker and Docker Compose
- A server with at least 4GB RAM
- A domain name pointing to your server

### Deploy

1. Clone the repo and configure:
```bash
git clone https://github.com/trajche/rembro.git
cd rembro
```

2. Edit `Caddyfile` with your domain and set `BASE_URL` in `docker-compose.yml`.

3. Start:
```bash
docker compose up -d
```

The server runs on port 3000 behind Caddy (auto-HTTPS). Sessions auto-expire after 30 minutes of inactivity (configurable via `SESSION_TTL_MS` environment variable).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `https://rembro.digitalno.de` | Public URL of the server |
| `SESSION_TTL_MS` | `1800000` (30 min) | Session inactivity timeout |

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **Browser automation:** Playwright (Chromium, Firefox, WebKit)
- **Display server:** Xvfb (virtual framebuffer)
- **VNC:** x11vnc + noVNC (browser-based viewer via WebSocket)
- **MCP transport:** Streamable HTTP via `@modelcontextprotocol/sdk`
- **HTTP server:** Express
- **OCR:** Tesseract (system package)
- **Reverse proxy:** Caddy (auto-HTTPS)
- **Tunneling:** SSH reverse tunnels
- **Container:** Docker + Docker Compose

## License

MIT
