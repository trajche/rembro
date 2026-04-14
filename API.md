# Rembro API Reference

Complete guide to using the Rembro API. Two ways to interact:

1. **MCP tools** — called by AI agents (Claude Code, etc.) via the MCP protocol at `/mcp`. Tool parameters use flat, snake_case keys (e.g. `viewport_preset`).
2. **REST API** — plain HTTP. Request bodies use nested camelCase objects (e.g. `viewport: { preset: ... }`).

Base URL: `https://rembro.digitalno.de`

---

## Table of Contents

- [Quick start](#quick-start)
- [Creating sessions](#creating-sessions)
- [Setting resolution / viewport](#setting-resolution--viewport)
- [Multi-browser (Chrome/Firefox/WebKit)](#multi-browser)
- [Navigation & interaction](#navigation--interaction)
- [Screenshots & OCR](#screenshots--ocr)
- [Multi-tab](#multi-tab)
- [iframes](#iframes)
- [Cookies, storage, auth state](#cookies-storage-auth-state)
- [Downloads](#downloads)
- [Network recording (HAR)](#network-recording-har)
- [Network mocking](#network-mocking)
- [PDF generation](#pdf-generation)
- [Logs & debugging](#logs--debugging)
- [Session management](#session-management)
- [Live log streaming (SSE)](#live-log-streaming-sse)

---

## Quick start

### Connect an AI agent (MCP)

Add to `.mcp.json`:
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

A browser session is created automatically on first connect. Your agent can now call any of the 60 tools.

### REST API — minimal example

```bash
# Create a session, navigate, screenshot — all via REST
SESSION=$(curl -s -X POST https://rembro.digitalno.de/api/sessions | jq -r .id)
echo "VNC: https://rembro.digitalno.de/vnc/$SESSION"

# (interact via MCP or directly via internal tools — REST currently
#  only exposes session lifecycle; use MCP for browser actions)
```

The REST API manages sessions; browser interactions (navigate, click, etc.) are exposed via MCP.

---

## Creating sessions

### MCP: `create_session`

All parameters are optional. Omitting everything gives you Chromium at 1280x720.

**Minimal:**
```json
{}
```

**Common options (flat keys for MCP):**
```json
{
  "browser": "firefox",
  "viewport_preset": "iphone-14",
  "locale": "en-US",
  "timezone_id": "America/New_York",
  "color_scheme": "dark"
}
```

**Full parameter list:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `browser` | `"chromium" \| "firefox" \| "webkit"` | Browser engine (default: chromium) |
| `viewport_preset` | string | Named preset (see below) |
| `viewport_device` | string | Alias for `viewport_preset` |
| `viewport_width` | int | Custom width in pixels |
| `viewport_height` | int | Custom height in pixels |
| `viewport_scale` | number | Device scale factor (e.g. 2 for retina) |
| `viewport_mobile` | boolean | Emulate mobile device |
| `viewport_touch` | boolean | Enable touch events |
| `chrome_args` | string[] | Extra Chromium launch args |
| `proxy_server` | string | Proxy URL (e.g. `http://proxy:8080` or `socks5://proxy:1080`) |
| `proxy_bypass` | string | Proxy bypass list (e.g. `*.google.com`) |
| `proxy_username` | string | Proxy auth username |
| `proxy_password` | string | Proxy auth password |
| `color_scheme` | `"light" \| "dark" \| "no-preference"` | `prefers-color-scheme` |
| `locale` | string | e.g. `en-US`, `de-DE` |
| `timezone_id` | string | IANA timezone (e.g. `America/New_York`) |
| `geo_latitude` | number | Geolocation latitude |
| `geo_longitude` | number | Geolocation longitude |
| `geo_accuracy` | number | Geolocation accuracy (meters) |
| `user_agent` | string | Custom User-Agent string |

### REST: `POST /api/sessions`

The REST API uses nested objects (not flat snake_case):

```bash
curl -X POST https://rembro.digitalno.de/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "browser": "firefox",
    "viewport": { "preset": "iphone-14" },
    "locale": "en-US",
    "timezoneId": "America/New_York",
    "colorScheme": "dark",
    "geolocation": { "latitude": 40.7128, "longitude": -74.0060 }
  }'
```

Response:
```json
{
  "id": "009cdb43-ad00-49d2-8344-2e1dda65f2a3",
  "browserType": "firefox",
  "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 3, "isMobile": true },
  "vncUrl": "https://rembro.digitalno.de/vnc/009cdb43-...",
  "currentUrl": "about:blank",
  "createdAt": "2026-04-14T08:30:40.389Z",
  "uptime": 0,
  "idleSeconds": 0
}
```

---

## Setting resolution / viewport

### Named presets

| Preset | Resolution | Scale | Mobile | Touch |
|--------|-----------|-------|--------|-------|
| `iphone-14` | 390×844 | 3× | yes | yes |
| `iphone-14-pro` | 393×852 | 3× | yes | yes |
| `pixel-7` | 412×915 | 2.625× | yes | yes |
| `ipad-pro` | 1024×1366 | 2× | yes | yes |
| `desktop-hd` | 1280×720 (default) | 1× | no | no |
| `desktop-fhd` | 1920×1080 | 1× | no | no |
| `desktop-2k` | 2560×1440 | 1× | no | no |
| `desktop-4k` | 3840×2160 | 1× | no | no |

### Examples

**iPhone 14 (MCP):**
```json
{ "viewport_preset": "iphone-14" }
```

**4K desktop (MCP):**
```json
{ "viewport_preset": "desktop-4k" }
```

**Custom resolution (MCP):**
```json
{
  "viewport_width": 1440,
  "viewport_height": 900,
  "viewport_scale": 2
}
```

**Mobile emulation with custom dims (MCP):**
```json
{
  "viewport_width": 375,
  "viewport_height": 667,
  "viewport_mobile": true,
  "viewport_touch": true,
  "viewport_scale": 2,
  "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ..."
}
```

**REST equivalents:**
```json
// Preset
{ "viewport": { "preset": "iphone-14" } }

// Custom
{
  "viewport": {
    "width": 1440,
    "height": 900,
    "deviceScaleFactor": 2,
    "isMobile": false,
    "hasTouch": false
  }
}
```

### Change viewport mid-session

MCP: `set_viewport`
```json
{
  "width": 1920,
  "height": 1080,
  "deviceScaleFactor": 1
}
```

Note: Xvfb display is started at `max(viewport, 1920×1080)`. Viewport changes beyond the Xvfb size aren't possible without session restart.

### List available presets

MCP: `list_viewport_presets` (no params) → returns the preset table above.

---

## Multi-browser

Pick a browser engine at session creation. Default is Chromium.

```json
// Firefox
{ "browser": "firefox" }

// WebKit (Safari engine)
{ "browser": "webkit" }
```

**Browser-specific notes:**
- Chromium: full CDP support, PDF generation, Chrome extensions (when that feature lands)
- Firefox: no CDP-based tools (`save_pdf` won't work), otherwise full parity
- WebKit: closest to Safari behavior for testing iOS/macOS browser quirks

---

## Navigation & interaction

### Navigate

**MCP: `navigate`**
```json
{ "url": "https://example.com" }
```

### Click an element

**MCP: `click`**
```json
{ "selector": "button.submit" }
```

### Click at pixel coordinates

Useful for canvas apps or when you have OCR coordinates.

**MCP: `click_at_coordinates`**
```json
{ "x": 640, "y": 320, "button": "left", "clickCount": 1 }
```

### Fill an input

**MCP: `fill`**
```json
{ "selector": "input[name=email]", "value": "user@example.com" }
```

### Type via keyboard

**MCP: `type`**
```json
{ "text": "Hello world" }
```

### Press a key

**MCP: `press_key`**
```json
{ "key": "Enter" }
// other examples: "Tab", "Escape", "ArrowDown", "Control+A"
```

### Hover

**MCP: `hover`** — `{ "selector": ".menu-item" }`

### Select dropdown

**MCP: `select_option`**
```json
{ "selector": "select#country", "value": "US" }
```

### Drag and drop

**MCP: `drag_and_drop`**
```json
{ "source": ".card-1", "target": ".column-done" }
```

### Wait

**MCP: `wait_for_selector`**
```json
{ "selector": ".loaded", "timeout": 10000 }
```

**MCP: `wait`** — `{ "ms": 2000 }`

---

## Screenshots & OCR

### Full-page screenshot

**MCP: `screenshot`**
```json
{}
```

Returns `{ type: "image", mimeType: "image/png", data: "<base64>" }`.

### Element screenshot

```json
{ "selector": ".hero-section" }
```

### Screenshot + OCR

Get both the image and extracted text in one call:
```json
{ "ocr": true }
```

### Standalone OCR (text only)

Smaller payload — no base64 image returned.

**MCP: `ocr`**
```json
{ "structured": false }
// or for word-level bounding boxes:
{ "structured": true }
```

Structured output (useful with `click_at_coordinates`):
```json
[
  { "text": "Login", "x": 540, "y": 320, "width": 80, "height": 24, "confidence": 95 },
  { "text": "Submit", "x": 600, "y": 450, "width": 90, "height": 24, "confidence": 92 }
]
```

### Accessibility tree

Much better than HTML for AI agents — gives a semantic view of the page.

**MCP: `get_accessibility_tree`**
```json
{ "interestingOnly": true }
```

Or scoped to a specific element:
```json
{ "selector": "main", "interestingOnly": true }
```

---

## Multi-tab

### List tabs

**MCP: `list_pages`** — `{}`

Returns:
```json
[
  { "index": 0, "url": "https://example.com", "title": "Example", "isActive": true },
  { "index": 1, "url": "https://google.com", "title": "Google", "isActive": false }
]
```

### Open a new tab

**MCP: `new_page`**
```json
{ "url": "https://example.com" }
// or without navigating:
{}
```

### Switch the active tab

**MCP: `switch_page`** — `{ "index": 1 }`

### Close a tab

**MCP: `close_page`**
```json
{ "index": 1 }
// or close active tab:
{}
```

---

## iframes

### List all frames

**MCP: `list_frames`** — `{}`

### Switch active frame

After this, `click`, `fill`, `get_text`, etc. all operate inside the iframe.

**MCP: `switch_frame`**
```json
{ "selector": "iframe#payment-form" }
// or back to main frame:
{}
```

### One-off frame interactions (without switching)

**MCP: `frame_click`**
```json
{ "frame": "iframe#payment", "selector": "button.pay" }
```

**MCP: `frame_fill`**
```json
{ "frame": "iframe#payment", "selector": "input[name=card]", "value": "4242..." }
```

**MCP: `frame_get_text`, `frame_get_html`** — same pattern.

---

## Cookies, storage, auth state

### Cookies

**MCP: `get_cookies`** — `{}` (or `{ "urls": ["https://..."] }`)

**MCP: `set_cookies`**
```json
{
  "cookies": [
    {
      "name": "session",
      "value": "abc123",
      "domain": "example.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ]
}
```

**MCP: `clear_cookies`** — `{}`

### localStorage / sessionStorage

**MCP: `get_storage`**
```json
{ "type": "localStorage" }
// or specific keys:
{ "type": "localStorage", "keys": ["token", "user"] }
```

**MCP: `set_storage`**
```json
{
  "type": "localStorage",
  "entries": { "token": "abc123", "user": "john" }
}
```

### Save & restore auth state

Log in once, reuse across sessions.

**MCP: `save_auth_state`** — `{}` → returns a JSON string.

**MCP: `restore_auth_state`**
```json
{ "state": "<JSON string from save_auth_state>" }
```

Creates a fresh browser context pre-populated with all cookies and storage.

---

## Downloads

### Wait for a download

Triggers a click and captures the resulting download.

**MCP: `wait_for_download`**
```json
{ "action": "click", "selector": "a.download-csv", "timeout": 10000 }
```

Response includes download ID, filename, size.

### List downloads

**MCP: `get_downloads`** — `{}`

### Get file content

**MCP: `get_download_content`**
```json
{ "id": 1, "encoding": "text" }
// or base64:
{ "id": 1, "encoding": "base64" }
```

Image files are returned as `{ type: "image" }`; text files as `{ type: "text" }`; binary as base64.

---

## Network recording (HAR)

### Start recording

**MCP: `start_har_recording`** — `{}`

### Stop and export

**MCP: `stop_har_recording`**
```json
{ "format": "full" }
// or compact summary (method/URL/status/timing):
{ "format": "summary" }
```

Returns HAR 1.2 format. Response bodies captured for JSON/text/XML content types, capped at 50KB each.

### One-off response capture

Wait for and capture a specific response by URL match.

**MCP: `get_response_body`**
```json
{ "url": "/api/users", "timeout": 10000 }
```

Returns `{ url, status, headers, body }`.

---

## Network mocking

### Mock a route

Intercept requests matching a glob and return a custom response.

**MCP: `mock_route`**
```json
{
  "pattern": "**/api/users/*",
  "status": 200,
  "body": "{\"id\": 1, \"name\": \"Alice\"}",
  "contentType": "application/json",
  "headers": { "X-Custom": "value" }
}
```

### Block requests

Drop requests matching a pattern (useful for blocking analytics, images, ads).

**MCP: `block_route`**
```json
{ "pattern": "**/*.png" }
// or
{ "pattern": "**/analytics.js" }
```

### Manage routes

**MCP: `list_routes`** — `{}`
**MCP: `clear_routes`** — `{}` (removes all)

---

## PDF generation

**Chromium only.** Uses Chrome DevTools Protocol.

**MCP: `save_pdf`**
```json
{
  "format": "A4",
  "landscape": false,
  "printBackground": true,
  "scale": 1,
  "margin": { "top": "0.5in", "bottom": "0.5in", "left": "0.5in", "right": "0.5in" }
}
```

Formats: `A4`, `Letter`, `Legal`, `A3`. Returns a `data:application/pdf;base64,...` URI.

---

## Logs & debugging

All logs (console, network, pageerror) are captured into a ring buffer (1000 entries). Reads are non-destructive with cursor-based pagination.

### Get logs

**MCP: `get_logs`**
```json
{
  "category": "network",
  "level": "error",
  "since": 42,
  "limit": 100,
  "urlFilter": "/api/"
}
```

- `category`: `"console" | "network" | "pageerror" | "performance" | "all"`
- `level`: `"debug" | "info" | "warn" | "error" | "log" | "all"`
- `since`: only return logs with `id > since` (cursor from previous response)
- `urlFilter`: substring match on network log messages

Response includes a `cursor` for the next poll.

### Get errors (convenience)

All JS exceptions + console errors + HTTP 4xx/5xx:

**MCP: `get_errors`** — `{}` or `{ "since": 42 }`

### Network log (convenience)

**MCP: `get_network_log`**
```json
{
  "urlFilter": "/api/",
  "statusFilter": 500,
  "errorsOnly": true,
  "limit": 50
}
```

### Console logs (backward compat)

**MCP: `get_console_logs`** — `{}` returns console entries as plain strings.

---

## Session management

### REST

```bash
# Create session
curl -X POST https://rembro.digitalno.de/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"browser": "chromium", "viewport": {"preset": "desktop-fhd"}}'

# List all
curl https://rembro.digitalno.de/api/sessions

# Get one
curl https://rembro.digitalno.de/api/sessions/<id>

# Kill one
curl -X DELETE https://rembro.digitalno.de/api/sessions/<id>

# Kill all (bulk)
curl -X DELETE https://rembro.digitalno.de/api/sessions

# Health
curl https://rembro.digitalno.de/health
```

### MCP

- `get_session_info` → current session ID, VNC URL, viewport
- `list_sessions` → all sessions on the server
- `destroy_session` → `{ "sessionId": "<uuid>" }`

### Auto-cleanup

Sessions are killed after **30 minutes of inactivity** (default). Configurable via `SESSION_TTL_MS` env var when self-hosting.

---

## Live log streaming (SSE)

Stream logs from a session in real time:

```bash
curl -N https://rembro.digitalno.de/api/sessions/<id>/logs/stream
```

Each event is a JSON-encoded `LogEntry`:
```
data: {"id":1,"timestamp":1713090000000,"category":"network","level":"info","message":"→ GET https://example.com/api","metadata":{...}}

data: {"id":2,"timestamp":1713090000100,"category":"network","level":"info","message":"← 200 https://example.com/api","metadata":{...}}
```

Useful for piping into a dashboard or debugging tool.

---

## Common patterns

### "Log in, then let the AI continue"

```json
// 1. Set cookies from your auth system
{ "cookies": [{ "name": "session", "value": "...", "domain": "..." }] }

// 2. Navigate to protected page
{ "url": "https://app.example.com/dashboard" }

// 3. Agent can now interact as the logged-in user
```

### "Click on text I can see"

```json
// 1. Get OCR with coordinates
{ "structured": true }

// 2. Pick the word you want, click at its center
{ "x": <word.x + word.width/2>, "y": <word.y + word.height/2> }
```

### "Capture an API response during a user flow"

```json
// 1. Start HAR recording
{}

// 2. Do some navigation/clicks
...

// 3. Stop and inspect
{ "format": "summary" }
```

### "Test mobile version"

```json
{ "viewport_preset": "iphone-14", "user_agent": "Mozilla/5.0 (iPhone; ...)" }
```

### "Block ads & trackers for cleaner screenshots"

```json
{ "pattern": "**/*.doubleclick.net/**" }
{ "pattern": "**/google-analytics.com/**" }
{ "pattern": "**/*.png" }  // all images
```
