# RemoteBrowserMCP

Remote browser sessions controlled by AI via MCP, with live VNC viewing and local service tunneling.

**Server:** https://rembro.digitalno.de

## Quick Start

### 1. Install the CLI

```bash
curl -sL https://rembro.digitalno.de/cli -o /usr/local/bin/rembro && chmod +x /usr/local/bin/rembro
```

### 2. Expose a local service

```bash
# Start your local app (e.g. on port 3000)
npm run dev

# In another terminal:
rembro expose 3000
```

That's it. The CLI will:
- Auto-download the tunnel key (first run only)
- Create a browser session
- Open an SSH tunnel so the remote browser can reach your `localhost:3000`
- Print the VNC URL where you can watch the browser live

### 3. Connect AI via MCP

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

Then ask Claude to navigate, click, screenshot, fill forms — it controls the remote browser.

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

## Web Dashboard

Open https://rembro.digitalno.de to:
- View active sessions
- Create new sessions with one click
- Get VNC links for each session
- Kill sessions

## REST API

```bash
# Create a session
curl -X POST https://rembro.digitalno.de/api/sessions

# List sessions
curl https://rembro.digitalno.de/api/sessions

# Kill a session
curl -X DELETE https://rembro.digitalno.de/api/sessions/<id>

# Health check
curl https://rembro.digitalno.de/health
```

## How It Works

```
Your Machine                          Hetzner Server (rembro.digitalno.de)
┌──────────────┐                      ┌──────────────────────────┐
│ localhost:3000│                      │ Session Container         │
│              │   SSH reverse tunnel  │ ┌──────────────────────┐ │
│ rembro CLI   │◄────────────────────►│ │ Chromium browser      │ │
│              │                      │ │ → navigates to        │ │
└──────────────┘                      │ │   localhost:3000      │ │
                                      │ ├──────────────────────┤ │
       You                            │ │ VNC (x11vnc)         │ │
┌──────────────┐                      │ │ → watch live at      │ │
│ Browser      │   WebSocket (VNC)    │ │   /vnc/<session-id>  │ │
│ VNC viewer   │◄────────────────────►│ └──────────────────────┘ │
└──────────────┘                      │                          │
                                      │ MCP Server (:3000)       │
       AI Agent                       │ → navigate, click,       │
┌──────────────┐   Streamable HTTP    │   screenshot, fill...    │
│ Claude Code  │◄────────────────────►│                          │
│ (MCP client) │                      └──────────────────────────┘
└──────────────┘
```

## MCP Tools Available

| Tool | Description |
|------|------------|
| `navigate` | Go to a URL |
| `screenshot` | Take a full-page screenshot |
| `click` | Click an element by CSS selector |
| `fill` | Fill an input field |
| `type` | Type text on keyboard |
| `press_key` | Press a key (Enter, Tab, etc.) |
| `hover` | Hover over an element |
| `select_option` | Select a dropdown option |
| `get_html` | Get page or element HTML |
| `get_text` | Get text content |
| `get_attribute` | Get element attribute |
| `execute_script` | Run JavaScript |
| `get_console_logs` | Get browser console output |
| `wait_for_selector` | Wait for element to appear |
| `wait` | Simple delay |
| `get_session_info` | Get session ID, VNC URL |
| `create_session` | Create additional sessions |
| `list_sessions` | List all active sessions |
| `destroy_session` | Kill a session |
| `go_back` / `go_forward` / `reload` | Navigation |
| `get_current_url` | Current page URL and title |
