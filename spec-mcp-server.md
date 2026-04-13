# MCP Browser Server Implementation Specification

**Version:** 1.0  
**Date:** April 13, 2026  
**Component:** Remote Browser MCP Server  
**Status:** Detailed Technical Specification

---

## 1. MCP Server Framework Selection

### 1.1 Framework Choice: TypeScript SDK

**Selected:** [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) via `@modelcontextprotocol/sdk` (npm)

**Rationale:**

1. **Official Implementation** — Anthropic-maintained, considered the reference implementation
2. **Best-in-Class Tooling** — First-class support for Streamable HTTP transport, SSE, and auth helpers
3. **Node.js Ecosystem** — Runs on Node.js, Bun, or Deno; integrates seamlessly with Playwright (Node.js-native)
4. **Production Readiness** — Used in official Playwright MCP, well-tested patterns
5. **Development Speed** — Rich type definitions, async/await support, excellent debugging
6. **Browser Automation Synergy** — Playwright/Puppeteer are Node.js libraries; same process model simplifies resource management

**Alternative Considered:** Python SDK (`modelcontextprotocol`) — suitable if team prefers Python, but adds transport layer complexity and slower startup for browser contexts.

### 1.2 Integration with Playwright

```typescript
// High-level architecture
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Browser, BrowserContext, Page } from "playwright";

// MCP Server wraps Playwright browser instance
class BrowserMCPServer {
  private server: Server;
  private browser: Browser;
  private contexts: Map<string, BrowserContext> = new Map();
  private pages: Map<string, Page> = new Map();

  constructor(browser: Browser) {
    this.browser = browser;
    this.server = new Server({
      name: "browser-mcp",
      version: "1.0.0",
    });
    this.setupTools();
  }

  private setupTools() {
    // Register all browser tools with MCP server
    this.server.setRequestHandler(CallToolRequestSchema, 
      this.handleToolCall.bind(this)
    );
  }
}
```

**Key Integration Points:**

- **Session Mapping:** Each MCP session ID maps to one Playwright `BrowserContext`
- **Page Management:** Navigation/interaction tools operate on current page within context
- **Resource Limits:** Browser context memory/CPU managed via Playwright's resource constraints
- **Cleanup:** Context destruction on session close

---

## 2. Tool Definitions

All tools use JSON-RPC 2.0 over Streamable HTTP. Tools are stateful per session (via context ID in headers).

### 2.1 Navigation Tools

#### `navigate`
Navigate to a URL and wait for load state.

```typescript
{
  name: "navigate",
  description: "Navigate to a URL and wait for page to load",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "Full URL to navigate to (must be http/https)"
      },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "Wait condition: load (default), domcontentloaded, networkidle"
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 30000)"
      }
    },
    required: ["url"]
  }
}

// Return type
interface NavigateResult {
  success: boolean;
  url: string;
  title: string;
  status_code: number;
  error?: string;
}
```

#### `go_back` / `go_forward` / `reload`

```typescript
{
  name: "go_back",
  description: "Navigate back in browser history",
  inputSchema: {
    type: "object" as const,
    properties: {
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        default: "load"
      }
    }
  }
}

// Return type: { success: boolean; url: string; error?: string }

{
  name: "go_forward",
  description: "Navigate forward in browser history",
  inputSchema: { /* same as go_back */ }
}

{
  name: "reload",
  description: "Reload current page",
  inputSchema: {
    type: "object" as const,
    properties: {
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        default: "load"
      }
    }
  }
}
```

### 2.2 Interaction Tools

#### `click`
Click an element by CSS selector or XPath.

```typescript
{
  name: "click",
  description: "Click an element on the page",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector or XPath for element"
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        default: "left",
        description: "Mouse button to click"
      },
      modifiers: {
        type: "array",
        items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        description: "Keyboard modifiers held during click"
      },
      delay: {
        type: "number",
        description: "Delay in ms before click (for double-click set delay=300)"
      }
    },
    required: ["selector"]
  }
}

// Return type
interface ClickResult {
  success: boolean;
  element_found: boolean;
  element_visible: boolean;
  error?: string;
}
```

#### `fill`
Fill a text input or textarea.

```typescript
{
  name: "fill",
  description: "Fill text input or textarea with value",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for input element"
      },
      value: {
        type: "string",
        description: "Text to fill (previous value is cleared)"
      },
      delay: {
        type: "number",
        description: "Delay between keystrokes in ms (0 for instant)"
      }
    },
    required: ["selector", "value"]
  }
}

// Return type
interface FillResult {
  success: boolean;
  element_found: boolean;
  previous_value?: string;
  new_value: string;
  error?: string;
}
```

#### `type`
Type text character-by-character (triggers input events, slower than fill).

```typescript
{
  name: "type",
  description: "Type text character-by-character (slower, triggers events)",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for input element (optional if already focused)"
      },
      text: {
        type: "string",
        description: "Text to type"
      },
      delay: {
        type: "number",
        description: "Delay between keystrokes in ms (default 50)"
      }
    },
    required: ["text"]
  }
}

// Return type: { success: boolean; characters_typed: number; error?: string }
```

#### `press_key`
Press keyboard keys (Enter, Tab, Escape, etc.).

```typescript
{
  name: "press_key",
  description: "Press keyboard keys (Enter, Tab, Escape, Backspace, etc.)",
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        description: "Key name (e.g., Enter, Tab, Escape, ArrowDown, etc.)"
      },
      selector: {
        type: "string",
        description: "Optional selector to focus before pressing"
      },
      count: {
        type: "number",
        description: "Number of times to press (default 1)"
      }
    },
    required: ["key"]
  }
}

// Return type: { success: boolean; key: string; count: number; error?: string }
```

#### `hover`
Hover mouse over an element.

```typescript
{
  name: "hover",
  description: "Move mouse to hover over an element",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for element"
      }
    },
    required: ["selector"]
  }
}

// Return type: { success: boolean; element_found: boolean; error?: string }
```

#### `select_option`
Select an option in a dropdown (select, datalist).

```typescript
{
  name: "select_option",
  description: "Select option(s) from a select/dropdown element",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for select element"
      },
      option: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } }
        ],
        description: "Option value(s) to select"
      }
    },
    required: ["selector", "option"]
  }
}

// Return type
interface SelectResult {
  success: boolean;
  options_selected: string[];
  error?: string;
}
```

### 2.3 Waiting & Timing Tools

#### `wait`
Wait for a specific condition.

```typescript
{
  name: "wait",
  description: "Wait for a condition (selector, navigation, function)",
  inputSchema: {
    type: "object" as const,
    properties: {
      condition: {
        type: "string",
        enum: ["selector", "navigation", "timeout"],
        description: "Type of wait condition"
      },
      selector: {
        type: "string",
        description: "CSS selector to wait for (used with condition=selector)"
      },
      state: {
        type: "string",
        enum: ["attached", "detached", "visible", "hidden"],
        description: "Element state to wait for (default: visible)"
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 30000)"
      }
    },
    required: ["condition"]
  }
}

// Return type
interface WaitResult {
  success: boolean;
  condition_met: boolean;
  time_elapsed_ms: number;
  error?: string;
}
```

#### `wait_for_navigation`
Wait for a navigation to complete.

```typescript
{
  name: "wait_for_navigation",
  description: "Wait for page navigation to complete",
  inputSchema: {
    type: "object" as const,
    properties: {
      timeout: {
        type: "number",
        description: "Timeout in ms (default 30000)"
      }
    }
  }
}

// Return type: { success: boolean; url: string; error?: string }
```

#### `wait_for_load_state`
Wait for page load state (load, domcontentloaded, networkidle).

```typescript
{
  name: "wait_for_load_state",
  description: "Wait for page to reach a specific load state",
  inputSchema: {
    type: "object" as const,
    properties: {
      state: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "Load state to wait for (default: load)"
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 30000)"
      }
    }
  }
}
```

### 2.4 Content & Data Extraction Tools

#### `screenshot`
Capture page screenshot (full page or element).

```typescript
{
  name: "screenshot",
  description: "Capture page screenshot as PNG (base64 encoded)",
  inputSchema: {
    type: "object" as const,
    properties: {
      full_page: {
        type: "boolean",
        description: "Capture full page height (true) or viewport only (false, default)"
      },
      selector: {
        type: "string",
        description: "Optional CSS selector to capture specific element only"
      },
      omit_devtools: {
        type: "boolean",
        description: "Omit browser devtools if visible (default true)"
      }
    }
  }
}

// Return type
interface ScreenshotResult {
  success: boolean;
  image_base64: string;
  format: "png";
  dimensions: {
    width: number;
    height: number;
  };
  error?: string;
}
```

#### `get_html`
Get page HTML or element HTML.

```typescript
{
  name: "get_html",
  description: "Get HTML source of page or element",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "Optional CSS selector for specific element (omit for full page)"
      },
      outer_html: {
        type: "boolean",
        description: "Include element's own tags (true) or inner HTML only (false, default)"
      }
    }
  }
}

// Return type
interface GetHtmlResult {
  success: boolean;
  html: string;
  element_found?: boolean;
  error?: string;
}
```

#### `get_text_content`
Get text content of page or element (stripped of HTML).

```typescript
{
  name: "get_text_content",
  description: "Get text content (no HTML) of page or element",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "Optional CSS selector for specific element"
      }
    }
  }
}

// Return type
interface GetTextContentResult {
  success: boolean;
  text: string;
  element_found?: boolean;
  error?: string;
}
```

#### `get_accessibility_tree`
Get accessibility tree (semantic understanding for LLMs).

```typescript
{
  name: "get_accessibility_tree",
  description: "Get page accessibility tree (roles, labels, hierarchy) for LLM understanding",
  inputSchema: {
    type: "object" as const,
    properties: {
      include_content: {
        type: "boolean",
        description: "Include element text content (default true)"
      },
      max_depth: {
        type: "number",
        description: "Maximum tree depth (default 5)"
      }
    }
  }
}

// Return type
interface AccessibilityNode {
  role: string;
  name?: string;
  description?: string;
  value?: string;
  children?: AccessibilityNode[];
}

interface GetAccessibilityTreeResult {
  success: boolean;
  tree: AccessibilityNode;
  error?: string;
}
```

#### `get_attribute`
Get attribute value of element.

```typescript
{
  name: "get_attribute",
  description: "Get attribute value of an element",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector for element"
      },
      attribute: {
        type: "string",
        description: "Attribute name (e.g., href, value, disabled, etc.)"
      }
    },
    required: ["selector", "attribute"]
  }
}

// Return type
interface GetAttributeResult {
  success: boolean;
  value: string | null;
  element_found: boolean;
  error?: string;
}
```

### 2.5 JavaScript Execution Tools

#### `execute_script`
Execute JavaScript in page context.

```typescript
{
  name: "execute_script",
  description: "Execute JavaScript in page context and return result",
  inputSchema: {
    type: "object" as const,
    properties: {
      script: {
        type: "string",
        description: "JavaScript code to execute (can use await)"
      },
      args: {
        type: "array",
        description: "Arguments to pass to script (available as arguments[0], arguments[1], etc.)"
      }
    },
    required: ["script"]
  }
}

// Return type
interface ExecuteScriptResult {
  success: boolean;
  result: unknown;
  error?: string;
  execution_time_ms: number;
}

// Example usage
{
  "script": "return document.title",
  "args": []
}

// Example with function
{
  "script": "async (name) => { await new Promise(r => setTimeout(r, 1000)); return `Hello, ${name}`; }",
  "args": ["World"]
}
```

#### `get_console_logs`
Get captured console output.

```typescript
{
  name: "get_console_logs",
  description: "Get captured console.log/warn/error output from page",
  inputSchema: {
    type: "object" as const,
    properties: {
      level: {
        type: "string",
        enum: ["log", "warn", "error", "info", "debug", "all"],
        description: "Filter by log level (default: all)"
      },
      since_id: {
        type: "number",
        description: "Return logs after this ID (for pagination)"
      },
      limit: {
        type: "number",
        description: "Maximum number of logs to return (default 100)"
      }
    }
  }
}

// Return type
interface ConsoleLog {
  id: number;
  level: "log" | "warn" | "error" | "info" | "debug";
  timestamp: number;
  message: string;
  args?: string[];
}

interface GetConsoleLogsResult {
  success: boolean;
  logs: ConsoleLog[];
  total_count: number;
  error?: string;
}
```

#### `evaluate`
Evaluate expression and return JSON-serializable result.

```typescript
{
  name: "evaluate",
  description: "Evaluate expression (shorter alternative to execute_script)",
  inputSchema: {
    type: "object" as const,
    properties: {
      expression: {
        type: "string",
        description: "JavaScript expression (no function wrapper needed)"
      }
    },
    required: ["expression"]
  }
}

// Return type
interface EvaluateResult {
  success: boolean;
  result: unknown;
  error?: string;
}

// Example: { "expression": "window.innerWidth" }
```

### 2.6 Network & Performance Tools

#### `get_network_logs`
Get captured network requests.

```typescript
{
  name: "get_network_logs",
  description: "Get captured network requests (XHR, fetch, img, etc.)",
  inputSchema: {
    type: "object" as const,
    properties: {
      filter_type: {
        type: "string",
        enum: ["xhr", "fetch", "document", "stylesheet", "image", "media", "font", "all"],
        description: "Filter by request type (default: all)"
      },
      since_id: {
        type: "number",
        description: "Return requests after this ID"
      },
      limit: {
        type: "number",
        description: "Maximum number of requests (default 100)"
      }
    }
  }
}

// Return type
interface NetworkRequest {
  id: number;
  method: string;
  url: string;
  status: number;
  type: string;
  timestamp: number;
  duration_ms: number;
  size_bytes?: number;
}

interface GetNetworkLogsResult {
  success: boolean;
  requests: NetworkRequest[];
  total_count: number;
  error?: string;
}
```

#### `get_page_metrics`
Get page performance metrics (Core Web Vitals, etc.).

```typescript
{
  name: "get_page_metrics",
  description: "Get page performance metrics (LCP, FID, CLS, load time, etc.)",
  inputSchema: {
    type: "object" as const,
    properties: {}
  }
}

// Return type
interface PageMetrics {
  page_load_time_ms: number;
  dom_content_loaded_ms: number;
  first_paint_ms?: number;
  first_contentful_paint_ms?: number;
  largest_contentful_paint_ms?: number;
  cumulative_layout_shift?: number;
  first_input_delay_ms?: number;
}

interface GetPageMetricsResult {
  success: boolean;
  metrics: PageMetrics;
  error?: string;
}
```

### 2.7 Session Management Tools

#### `get_current_state`
Get comprehensive current page state.

```typescript
{
  name: "get_current_state",
  description: "Get comprehensive current page state (URL, title, cookies, storage)",
  inputSchema: {
    type: "object" as const,
    properties: {
      include_accessibility: {
        type: "boolean",
        description: "Include accessibility tree (default false)"
      },
      include_network: {
        type: "boolean",
        description: "Include recent network logs (default false)"
      }
    }
  }
}

// Return type
interface PageState {
  url: string;
  title: string;
  status_code?: number;
  cookies?: Array<{ name: string; value: string }>;
  local_storage?: Record<string, string>;
  session_storage?: Record<string, string>;
  viewport: { width: number; height: number };
  is_mobile: boolean;
  user_agent: string;
}

interface GetCurrentStateResult {
  success: boolean;
  state: PageState;
  error?: string;
}
```

#### `clear_cookies` / `clear_storage`
Clear browser data.

```typescript
{
  name: "clear_cookies",
  description: "Clear all cookies in browser context",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "Optional specific cookie name to delete"
      }
    }
  }
}

// Return type: { success: boolean; count_deleted: number; error?: string }

{
  name: "clear_storage",
  description: "Clear localStorage and sessionStorage",
  inputSchema: {
    type: "object" as const,
    properties: {
      storage_type: {
        type: "string",
        enum: ["localStorage", "sessionStorage", "both"],
        description: "Which storage to clear (default: both)"
      }
    }
  }
}
```

#### `close_session`
Close browser context and cleanup resources.

```typescript
{
  name: "close_session",
  description: "Close browser session and cleanup resources",
  inputSchema: {
    type: "object" as const,
    properties: {}
  }
}

// Return type: { success: boolean; error?: string }
```

---

## 3. Transport Setup: Streamable HTTP

### 3.1 Server Endpoint Architecture

Single HTTP endpoint (`POST` and `GET` methods) handles all MCP communication.

```typescript
import express from "express";
import { BrowserMCPServer } from "./browser-mcp-server";

const app = express();
app.use(express.json({ limit: "10mb" }));

const browserServer = new BrowserMCPServer();

// Single MCP endpoint: both POST (client request) and GET (SSE stream)
app.post("/mcp", async (req, res) => {
  const { jsonrpc, method, params, id } = req.body;
  const sessionId = req.headers["x-session-id"] as string;
  const authToken = req.headers.authorization;

  try {
    // Authenticate
    if (!authToken) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    // Route to handler
    const result = await browserServer.handleRequest({
      jsonrpc,
      method,
      params,
      id,
      sessionId,
      authToken,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: String(error) },
      id,
    });
  }
});

// SSE stream endpoint for streaming responses
app.get("/mcp", (req, res) => {
  const sessionId = req.headers["x-session-id"] as string;
  const lastEventId = req.headers["last-event-id"] as string;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Subscribe session to SSE stream, replay from lastEventId if provided
  const unsubscribe = browserServer.subscribeToSession(sessionId, (event) => {
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }, lastEventId);

  req.on("close", () => {
    unsubscribe();
    res.end();
  });

  // Keep-alive ping every 30s
  const keepAliveInterval = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 30000);

  req.on("close", () => clearInterval(keepAliveInterval));
});

app.listen(3000, () => console.log("MCP server listening on :3000"));
```

### 3.2 Request/Response Format

**POST Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "navigate",
    "arguments": {
      "url": "https://example.com"
    }
  },
  "id": "req-12345"
}
```

**Headers:**
```
POST /mcp HTTP/1.1
Host: browser.example.com
Content-Type: application/json
Authorization: Bearer <jwt_token>
X-Session-ID: sess_abc123def456
X-Request-Timeout: 30000
```

**Successful Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "success": true,
    "url": "https://example.com",
    "title": "Example Domain",
    "status_code": 200
  },
  "id": "req-12345"
}
```

**Error Response:**
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32603,
    "message": "Navigation timeout after 30000ms",
    "data": {
      "type": "TimeoutError",
      "tool": "navigate"
    }
  },
  "id": "req-12345"
}
```

### 3.3 Streaming with SSE

**GET Request for SSE Stream:**
```
GET /mcp HTTP/1.1
Host: browser.example.com
Accept: text/event-stream
Authorization: Bearer <jwt_token>
X-Session-ID: sess_abc123def456
Last-Event-ID: evt_999
```

**SSE Response Stream:**
```
id: evt_1000
data: {"type":"tool_output","tool":"navigate","output":{"success":true}}

id: evt_1001
data: {"type":"console_log","level":"log","message":"Page loaded"}

id: evt_1002
data: {"type":"network_request","method":"GET","url":"https://cdn.example.com/app.js"}

: keep-alive
```

---

## 4. Auth Integration: OAuth 2.0 + JWT

### 4.1 OAuth 2.0 Authorization Flow

**Token Exchange Endpoint:** `POST /auth/token`

```typescript
import jwt from "jsonwebtoken";

app.post("/auth/token", express.json(), async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body;

  // Validate OAuth2 code (from authorization server)
  if (grant_type === "authorization_code") {
    const tokenData = await validateOAuthCode(code, client_id, client_secret);

    // Issue JWT token
    const jwtToken = jwt.sign(
      {
        sub: tokenData.user_id,
        tenant: tokenData.tenant_id,
        scope: "browser:read browser:write",
        iss: "https://browser.example.com",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      },
      process.env.JWT_SECRET!,
      { algorithm: "HS256" }
    );

    return res.json({
      access_token: jwtToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "browser:read browser:write",
    });
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});
```

### 4.2 JWT Validation Middleware

```typescript
import jwt from "jsonwebtoken";

interface AuthPayload {
  sub: string; // user_id
  tenant: string; // tenant_id
  scope: string;
  iss: string;
  iat: number;
  exp: number;
}

function validateAuthToken(token: string): AuthPayload {
  const bearer = token.replace(/^Bearer\s+/, "");

  try {
    const decoded = jwt.verify(bearer, process.env.JWT_SECRET!, {
      algorithms: ["HS256"],
    }) as AuthPayload;

    // Validate expiration
    if (decoded.exp < Math.floor(Date.now() / 1000)) {
      throw new Error("Token expired");
    }

    // Validate issuer
    if (decoded.iss !== "https://browser.example.com") {
      throw new Error("Invalid issuer");
    }

    return decoded;
  } catch (error) {
    throw new Error(`Invalid token: ${String(error)}`);
  }
}

// Apply to MCP endpoints
app.post("/mcp", (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Missing authorization header" });
  }

  try {
    req.auth = validateAuthToken(authHeader);
    next();
  } catch (error) {
    res.status(403).json({ error: String(error) });
  }
});
```

### 4.3 Session ↔ Tenant Mapping

```typescript
// Sessions are scoped to authenticated tenant
class SessionManager {
  private sessions: Map<string, SessionContext> = new Map();

  createSession(auth: AuthPayload): string {
    const sessionId = `sess_${randomUUID()}`;

    const context: SessionContext = {
      sessionId,
      tenantId: auth.tenant,
      userId: auth.sub,
      browserContext: null, // Created lazily
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      requestCount: 0,
    };

    this.sessions.set(sessionId, context);
    return sessionId;
  }

  getSession(sessionId: string, expectedTenantId: string): SessionContext {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Enforce tenant isolation
    if (session.tenantId !== expectedTenantId) {
      throw new Error(`Session does not belong to tenant ${expectedTenantId}`);
    }

    session.lastActivityAt = Date.now();
    session.requestCount++;

    return session;
  }

  deleteSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.browserContext) {
      session.browserContext.close();
    }
    this.sessions.delete(sessionId);
  }
}
```

---

## 5. Browser Lifecycle Management

### 5.1 Context Creation & Resource Limits

```typescript
import { chromium, BrowserContext } from "playwright";

class BrowserManager {
  private browser: Browser;
  private maxContextsPerTenant = 10;
  private maxPagesPerContext = 5;
  private contextMemoryLimitMb = 512;

  async createBrowserContext(tenantId: string): Promise<BrowserContext> {
    // Check resource limits
    const tenantContextCount = await this.countActiveContexts(tenantId);
    if (tenantContextCount >= this.maxContextsPerTenant) {
      throw new Error(
        `Tenant ${tenantId} has reached max ${this.maxContextsPerTenant} concurrent sessions`
      );
    }

    // Create new context with resource constraints
    const context = await this.browser.newContext({
      // Viewport for consistent screenshots
      viewport: { width: 1280, height: 720 },

      // User agent (can be customized)
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",

      // Timezone and locale
      locale: "en-US",
      timezoneId: "America/New_York",

      // Storage isolation per context
      storageState: undefined,

      // Proxy (if needed for private network access via WireGuard)
      proxy: process.env.WIREGUARD_PROXY
        ? { server: process.env.WIREGUARD_PROXY }
        : undefined,

      // Device settings
      isMobile: false,
      hasTouch: false,
      deviceScaleFactor: 1,

      // Memory management
      // Note: Playwright limits via OS level, monitor via process metrics
    });

    // Attach memory monitor
    this.monitorContextMemory(context, tenantId, this.contextMemoryLimitMb);

    // Setup console/network logging
    this.setupContextLogging(context);

    return context;
  }

  private setupContextLogging(context: BrowserContext) {
    const logs: ConsoleLog[] = [];

    context.on("page", (page) => {
      // Capture console output
      page.on("console", (msg) => {
        logs.push({
          id: logs.length,
          level: msg.type() as any,
          timestamp: Date.now(),
          message: msg.text(),
          args: msg.args().map((arg) => arg.toString()),
        });

        // Trim to recent 1000 logs
        if (logs.length > 1000) logs.shift();
      });

      // Capture network requests
      page.on("request", (request) => {
        const networkRequest: NetworkRequest = {
          id: this.networkRequestId++,
          method: request.method(),
          url: request.url(),
          type: request.resourceType(),
          status: 0,
          timestamp: Date.now(),
          duration_ms: 0,
        };

        // Capture response
        request.response().then((response) => {
          if (response) {
            networkRequest.status = response.status();
            networkRequest.duration_ms = Date.now() - networkRequest.timestamp;
          }
        });
      });
    });
  }

  private monitorContextMemory(
    context: BrowserContext,
    tenantId: string,
    limitMb: number
  ) {
    const checkInterval = setInterval(async () => {
      const pages = context.pages();
      let totalMemoryMb = 0;

      for (const page of pages) {
        try {
          const metrics = await page.metrics();
          totalMemoryMb += metrics.JSHeapUsedSize / (1024 * 1024);
        } catch (e) {
          // Page closed
        }
      }

      if (totalMemoryMb > limitMb) {
        console.warn(
          `Tenant ${tenantId} context memory ${totalMemoryMb}MB exceeds limit ${limitMb}MB`
        );
        // Signal client to reduce workload or close context
      }
    }, 5000);

    context.on("close", () => clearInterval(checkInterval));
  }

  async closeBrowserContext(context: BrowserContext) {
    // Close all pages
    for (const page of context.pages()) {
      await page.close();
    }

    // Close context
    await context.close();
  }
}
```

### 5.2 Page Management Within Context

```typescript
class PageManager {
  private currentPage: Page | null = null;
  private pageStack: Page[] = [];

  async createPage(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();

    // Set timeout for all operations
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    // Setup error handlers
    page.on("error", (err) => {
      console.error(`Page error: ${err.message}`);
    });

    page.on("crash", () => {
      console.error("Page crashed");
      this.pageStack = this.pageStack.filter((p) => p !== page);
    });

    this.currentPage = page;
    this.pageStack.push(page);

    return page;
  }

  async closePage(page: Page) {
    try {
      await page.close();
    } catch (e) {
      // Already closed
    }

    this.pageStack = this.pageStack.filter((p) => p !== page);

    // Switch to previous page if available
    if (this.pageStack.length > 0) {
      this.currentPage = this.pageStack[this.pageStack.length - 1];
    }
  }

  getCurrentPage(): Page {
    if (!this.currentPage) {
      throw new Error("No active page in context");
    }
    return this.currentPage;
  }
}
```

### 5.3 Session Cleanup & TTL

```typescript
class SessionCleanupManager {
  private sessionTTL = 30 * 60 * 1000; // 30 minutes
  private cleanupInterval = setInterval(
    () => this.cleanup(),
    5 * 60 * 1000
  ); // 5 minutes

  private cleanup() {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      const idleTime = now - session.lastActivityAt;

      if (idleTime > this.sessionTTL) {
        console.log(`Cleaning up idle session: ${sessionId}`);

        if (session.browserContext) {
          this.browserManager.closeBrowserContext(session.browserContext);
        }

        this.sessions.delete(sessionId);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
  }
}
```

---

## 6. Docker Image Specification

### 6.1 Dockerfile

```dockerfile
FROM node:20-bullseye-slim

LABEL maintainer="remotebrowser-mcp"
LABEL description="Remote Browser MCP Server with Playwright"

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxslt1.1 \
    libxss1 \
    libgconf-2-4 \
    libappindicator1 \
    libappindicator3-1 \
    libindicator7 \
    fonts-liberation \
    xdg-utils \
    ca-certificates \
    fonts-dejavu-core \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium (separate from Playwright for better layer caching)
RUN apt-get update && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY dist/ ./dist/
COPY src/ ./src/

# Create non-root user for security
RUN useradd -m -u 1000 browserapp
USER browserapp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose ports
EXPOSE 3000 5900 5901

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# Start server
CMD ["node", "dist/index.js"]
```

### 6.2 Docker Compose (with VNC & WireGuard)

```yaml
version: "3.9"

services:
  # MCP Browser Server
  browser-mcp:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: browser-mcp
    ports:
      - "3000:3000"  # MCP HTTP endpoint
      - "5900:5900"  # VNC server (direct)
    environment:
      NODE_ENV: production
      PORT: 3000
      JWT_SECRET: ${JWT_SECRET}
      CHROMIUM_PATH: /usr/bin/chromium
      BROWSER_EXECUTABLE_PATH: /usr/bin/chromium
      # VNC settings
      DISPLAY: :99
      XVFB_SCREEN: 1280x720x24
      VNC_PASSWORD: ${VNC_PASSWORD}
      # Optional: route through WireGuard for private network access
      WIREGUARD_PROXY: ${WIREGUARD_PROXY}
    depends_on:
      - xvfb
      - vnc
    networks:
      - browser-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Xvfb (virtual X display)
  xvfb:
    image: ubuntu:22.04
    container_name: xvfb
    entrypoint: /bin/bash
    command: -c "apt-get update && apt-get install -y xvfb && Xvfb :99 -screen 0 1280x720x24"
    environment:
      DISPLAY: :99
    networks:
      - browser-network
    restart: unless-stopped

  # VNC Server (TigerVNC)
  vnc:
    image: ubuntu:22.04
    container_name: vnc
    entrypoint: /bin/bash
    command: >
      -c "apt-get update && apt-get install -y tigervnc-server &&
          mkdir -p /root/.vnc &&
          echo '${VNC_PASSWORD}' | vncpasswd -f > /root/.vnc/passwd &&
          chmod 600 /root/.vnc/passwd &&
          vncserver :0 -geometry 1280x720 -depth 24"
    environment:
      DISPLAY: :99
    ports:
      - "5900:5900"
    networks:
      - browser-network
    restart: unless-stopped

  # WireGuard (optional, for private network access)
  wireguard:
    image: linuxserver/wireguard:latest
    container_name: wireguard
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=UTC
      - PEERS=${WIREGUARD_PEERS}
    volumes:
      - ./wireguard-config:/config
      - /lib/modules:/lib/modules
    ports:
      - "51820:51820/udp"
    networks:
      - browser-network
    restart: unless-stopped

networks:
  browser-network:
    driver: bridge
```

### 6.3 Environment Variables

```bash
# .env.example
NODE_ENV=production
PORT=3000

# JWT Configuration
JWT_SECRET=your-secret-key-here-at-least-32-chars

# VNC Configuration
VNC_PASSWORD=your-vnc-password
DISPLAY=:99
XVFB_SCREEN=1280x720x24

# Browser Configuration
CHROMIUM_PATH=/usr/bin/chromium
BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# WireGuard (if using private network)
WIREGUARD_PROXY=socks5://wireguard:1080
WIREGUARD_PEERS=1  # Number of peer configs to generate

# Session Configuration
MAX_SESSIONS_PER_TENANT=10
SESSION_TTL_MINUTES=30
CONTEXT_MEMORY_LIMIT_MB=512

# Logging
LOG_LEVEL=info
```

---

## 7. Example Client Usage

### 7.1 Claude Desktop Configuration

**File:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "browser": {
      "type": "sse",
      "url": "https://browser.example.com:3000/mcp",
      "auth": {
        "type": "bearer",
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
      },
      "headers": {
        "X-Session-ID": "sess_abc123def456"
      },
      "timeout": 60000
    }
  }
}
```

### 7.2 Cursor IDE Configuration

**File:** `.cursor/mcp_config.json`

```json
{
  "mcpServers": {
    "browser": {
      "type": "sse",
      "url": "https://browser.example.com:3000/mcp",
      "auth": {
        "type": "bearer",
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
      },
      "sessionId": "sess_abc123def456"
    }
  }
}
```

### 7.3 Custom Node.js Client

```typescript
import fetch from "node-fetch";

class BrowserMCPClient {
  private baseUrl: string;
  private authToken: string;
  private sessionId: string;

  constructor(baseUrl: string, authToken: string, sessionId: string) {
    this.baseUrl = baseUrl;
    this.authToken = authToken;
    this.sessionId = sessionId;
  }

  async callTool(toolName: string, args: Record<string, unknown>) {
    const response = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
        "X-Session-ID": this.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
        id: `req-${Date.now()}`,
      }),
    });

    const result = await response.json();

    if (result.error) {
      throw new Error(
        `Tool error: ${result.error.message}`
      );
    }

    return result.result;
  }

  async navigate(url: string) {
    return this.callTool("navigate", { url, wait_until: "networkidle" });
  }

  async click(selector: string) {
    return this.callTool("click", { selector });
  }

  async fill(selector: string, value: string) {
    return this.callTool("fill", { selector, value });
  }

  async screenshot(fullPage = false) {
    const result = await this.callTool("screenshot", { full_page: fullPage });
    return Buffer.from(result.image_base64, "base64");
  }

  async getHTML(selector?: string) {
    return this.callTool("get_html", { selector });
  }

  async getAccessibilityTree() {
    return this.callTool("get_accessibility_tree", {});
  }
}

// Usage
const client = new BrowserMCPClient(
  "https://browser.example.com:3000",
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "sess_abc123def456"
);

await client.navigate("https://example.com");
await client.click('button[aria-label="Search"]');
await client.fill("input[type=search]", "browser MCP");
const screenshot = await client.screenshot(true);
const tree = await client.getAccessibilityTree();
```

### 7.4 Python Client (asyncio)

```python
import aiohttp
import asyncio
import base64

class BrowserMCPClient:
    def __init__(self, base_url: str, auth_token: str, session_id: str):
        self.base_url = base_url
        self.auth_token = auth_token
        self.session_id = session_id
        self.request_id = 0

    async def call_tool(self, tool_name: str, args: dict):
        self.request_id += 1
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.auth_token}",
            "X-Session-ID": self.session_id,
        }

        payload = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": args,
            },
            "id": f"req-{self.request_id}",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.base_url}/mcp",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                result = await resp.json()

                if "error" in result:
                    raise Exception(f"Tool error: {result['error']['message']}")

                return result.get("result")

    async def navigate(self, url: str):
        return await self.call_tool("navigate", {"url": url, "wait_until": "networkidle"})

    async def click(self, selector: str):
        return await self.call_tool("click", {"selector": selector})

    async def screenshot(self, full_page: bool = False):
        result = await self.call_tool("screenshot", {"full_page": full_page})
        return base64.b64decode(result["image_base64"])

    async def get_accessibility_tree(self):
        return await self.call_tool("get_accessibility_tree", {})

# Usage
async def main():
    client = BrowserMCPClient(
        "https://browser.example.com:3000",
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
        "sess_abc123def456",
    )

    await client.navigate("https://example.com")
    await client.click('a[href="/search"]')
    screenshot = await client.screenshot()
    tree = await client.get_accessibility_tree()

    print(f"Screenshot size: {len(screenshot)} bytes")
    print(f"Accessibility tree: {tree}")

asyncio.run(main())
```

---

## 8. Startup & Health Checks

### 8.1 Health Check Endpoint

```typescript
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    browser_status: this.browserManager.isReady() ? "ready" : "starting",
    active_sessions: this.sessionManager.getActiveSessionCount(),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };

  const statusCode = health.browser_status === "ready" ? 200 : 503;
  res.status(statusCode).json(health);
});

app.get("/health/ready", (req, res) => {
  if (this.browserManager.isReady()) {
    res.status(200).json({ ready: true });
  } else {
    res.status(503).json({ ready: false });
  }
});
```

### 8.2 Startup Sequence

```typescript
async function startServer() {
  console.log("Starting Browser MCP Server...");

  try {
    // 1. Initialize browser
    console.log("Launching Chromium...");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    // 2. Initialize managers
    const browserManager = new BrowserManager(browser);
    const sessionManager = new SessionManager(browserManager);
    const browserServer = new BrowserMCPServer(sessionManager);

    // 3. Setup Express
    const app = express();
    app.use(express.json({ limit: "10mb" }));

    // Register routes
    registerMCPEndpoints(app, browserServer);
    registerAuthEndpoints(app);
    registerHealthCheckEndpoints(app, browserManager);

    // 4. Start server
    const PORT = parseInt(process.env.PORT || "3000");
    const server = app.listen(PORT, () => {
      console.log(`✓ MCP Server running on port ${PORT}`);
      console.log(`✓ Health check: http://localhost:${PORT}/health`);
      console.log(`✓ MCP endpoint: http://localhost:${PORT}/mcp`);
    });

    // 5. Graceful shutdown
    process.on("SIGTERM", async () => {
      console.log("SIGTERM received, shutting down gracefully...");
      server.close(() => {
        console.log("HTTP server closed");
      });

      sessionManager.destroy();
      await browser.close();
      process.exit(0);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
```

---

## 9. Security Considerations

### 9.1 Token Validation

- ✓ JWT signature verification
- ✓ Token expiration check
- ✓ Issuer validation
- ✓ Tenant isolation enforcement
- ✓ Rate limiting per tenant/session

### 9.2 Resource Isolation

- ✓ Max contexts per tenant
- ✓ Memory limits per context
- ✓ Timeout enforcement on all operations
- ✓ Page isolation within context

### 9.3 Network Security

- ✓ TLS/HTTPS for all connections
- ✓ Bearer token in Authorization header (not URL params)
- ✓ CORS disabled by default
- ✓ Optional WireGuard for private network access

### 9.4 Content Security

- ✓ No storage of page content beyond request scope
- ✓ Console/network logs purged on session close
- ✓ Cookies/storage cleared between contexts
- ✓ JavaScript execution in isolated context

---

## Sources & References

- [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Playwright API Documentation](https://playwright.dev/docs/api/class-browser)
- [MCP Streamable HTTP Transport](https://docs.roocode.com/features/mcp/server-transports)
- [Express.js HTTP Server](https://expressjs.com/)
- [JWT Authentication](https://jwt.io/)
