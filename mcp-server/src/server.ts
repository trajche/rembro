import express from "express";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { spawn, execFile, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import net from "net";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type BrowserType } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

const BASE_URL = process.env.BASE_URL || "https://rembro.digitalno.de";
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured log types
// ---------------------------------------------------------------------------

interface LogEntry {
  id: number;
  timestamp: number;
  category: "console" | "network" | "pageerror" | "performance";
  level: "debug" | "info" | "warn" | "error" | "log";
  message: string;
  metadata?: Record<string, unknown>;
}

interface SessionLogStore {
  entries: LogEntry[];
  nextId: number;
  maxEntries: number;
  listeners: Array<(entry: LogEntry) => void>;
}

function createLogStore(maxEntries = 1000): SessionLogStore {
  return { entries: [], nextId: 1, maxEntries, listeners: [] };
}

function addLog(store: SessionLogStore, entry: Omit<LogEntry, "id" | "timestamp">): void {
  const full: LogEntry = { ...entry, id: store.nextId++, timestamp: Date.now() };
  store.entries.push(full);
  if (store.entries.length > store.maxEntries) {
    store.entries.shift(); // ring buffer behavior
  }
  for (const listener of store.listeners) {
    try { listener(full); } catch {}
  }
}

// ---------------------------------------------------------------------------
// OCR helper — uses system tesseract via child_process
// ---------------------------------------------------------------------------

interface OCRWord { text: string; x: number; y: number; width: number; height: number; confidence: number; }
interface OCRResult { text: string; words: OCRWord[]; }

async function runOCR(imageBuffer: Buffer): Promise<OCRResult> {
  const tmpIn = join(tmpdir(), `ocr-${Date.now()}.png`);
  const tmpOut = join(tmpdir(), `ocr-${Date.now()}`);
  writeFileSync(tmpIn, imageBuffer);

  return new Promise((resolve, reject) => {
    execFile("tesseract", [tmpIn, tmpOut, "--tsv"], (err) => {
      try { unlinkSync(tmpIn); } catch {}
      if (err) { reject(err); return; }

      const tsv = readFileSync(tmpOut + ".tsv", "utf-8");
      try { unlinkSync(tmpOut + ".tsv"); } catch {}

      const lines = tsv.trim().split("\n").slice(1);
      const words: OCRWord[] = [];
      const textParts: string[] = [];

      for (const line of lines) {
        const cols = line.split("\t");
        const conf = parseInt(cols[10]);
        const text = cols[11]?.trim();
        if (conf > 0 && text) {
          words.push({ text, x: parseInt(cols[6]), y: parseInt(cols[7]), width: parseInt(cols[8]), height: parseInt(cols[9]), confidence: conf });
          textParts.push(text);
        }
      }
      resolve({ text: textParts.join(" "), words });
    });
  });
}

// ---------------------------------------------------------------------------
// Session Manager — each session gets its own Xvfb, x11vnc, and Chromium
// ---------------------------------------------------------------------------

interface BrowserSession {
  id: string;
  displayNum: number;
  vncPort: number;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pages: Page[];
  activePageIndex: number;
  logs: SessionLogStore;
  xvfb: ChildProcess;
  x11vnc: ChildProcess;
  createdAt: Date;
}

const browserSessions = new Map<string, BrowserSession>();
let nextDisplayNum = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createBrowserSession(): Promise<BrowserSession> {
  const id = randomUUID();
  const displayNum = nextDisplayNum++;
  const vncPort = 5900 + displayNum; // e.g. display :100 -> port 6000

  // Start Xvfb
  const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", "1280x720x24", "-ac"], {
    stdio: "ignore",
  });
  await sleep(500);

  // Start x11vnc
  const x11vnc = spawn(
    "x11vnc",
    ["-display", `:${displayNum}`, "-forever", "-shared", "-nopw", "-rfbport", String(vncPort)],
    { stdio: "ignore" },
  );
  await sleep(300);

  // Launch Chromium on this display
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    env: { ...process.env, DISPLAY: `:${displayNum}` } as Record<string, string>,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const session: BrowserSession = {
    id,
    displayNum,
    vncPort,
    browser,
    context,
    page,
    pages: [page],
    activePageIndex: 0,
    logs: createLogStore(),
    xvfb,
    x11vnc,
    createdAt: new Date(),
  };

  // Wire up structured log listeners for all event types
  const wirePageLogListeners = (p: Page) => {
    p.on("console", (msg) => {
      addLog(session.logs, {
        category: "console",
        level: msg.type() as LogEntry["level"],
        message: msg.text(),
        metadata: { location: msg.location() },
      });
    });

    p.on("pageerror", (error) => {
      addLog(session.logs, {
        category: "pageerror",
        level: "error",
        message: error.message,
        metadata: { stack: error.stack, name: error.name },
      });
    });

    p.on("request", (request) => {
      addLog(session.logs, {
        category: "network",
        level: "info",
        message: `→ ${request.method()} ${request.url()}`,
        metadata: {
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
        },
      });
    });

    p.on("response", (response) => {
      addLog(session.logs, {
        category: "network",
        level: response.status() >= 400 ? "error" : "info",
        message: `← ${response.status()} ${response.url()}`,
        metadata: {
          status: response.status(),
          statusText: response.statusText(),
          url: response.url(),
        },
      });
    });

    p.on("requestfailed", (request) => {
      addLog(session.logs, {
        category: "network",
        level: "error",
        message: `✗ ${request.method()} ${request.url()} — ${request.failure()?.errorText}`,
        metadata: {
          method: request.method(),
          url: request.url(),
          error: request.failure()?.errorText,
        },
      });
    });
  };

  wirePageLogListeners(page);

  context.on("page", (newPage) => {
    session.pages.push(newPage);
    wirePageLogListeners(newPage);
  });

  browserSessions.set(id, session);
  console.log(`Session ${id.slice(0, 8)} created (display :${displayNum}, vnc port ${vncPort})`);
  return session;
}

async function destroyBrowserSession(id: string): Promise<boolean> {
  const session = browserSessions.get(id);
  if (!session) return false;

  try { await session.page.close().catch(() => {}); } catch {}
  try { await session.context.close().catch(() => {}); } catch {}
  try { await session.browser.close().catch(() => {}); } catch {}
  try { session.x11vnc.kill(); } catch {}
  try { session.xvfb.kill(); } catch {}

  browserSessions.delete(id);
  console.log(`Session ${id.slice(0, 8)} destroyed`);
  return true;
}

function sessionToJSON(s: BrowserSession) {
  return {
    id: s.id,
    vncUrl: `${BASE_URL}/vnc/${s.id}`,
    currentUrl: s.page.isClosed() ? "(closed)" : s.page.url(),
    createdAt: s.createdAt.toISOString(),
    uptime: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
  };
}

// ---------------------------------------------------------------------------
// MCP server factory — tools scoped to a browser session
// ---------------------------------------------------------------------------

function createMcpServer(mcpSessionId: string, browserSessionId: string): McpServer {
  const server = new McpServer({ name: "remotebrowser-mcp", version: "0.2.0" });

  const getSession = (): BrowserSession => {
    const s = browserSessions.get(browserSessionId);
    if (!s) throw new Error("Browser session not found");
    return s;
  };
  const getPage = (): Page => {
    const s = getSession();
    if (s.page.isClosed()) throw new Error("Page is closed");
    return s.page;
  };

  // ---- Session management --------------------------------------------------

  server.tool("create_session", {}, async () => {
    try {
      const s = await createBrowserSession();
      return { content: [{ type: "text", text: JSON.stringify(sessionToJSON(s), null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("list_sessions", {}, async () => {
    const list = Array.from(browserSessions.values()).map(sessionToJSON);
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool("get_session_info", {}, async () => {
    try {
      const s = getSession();
      const info = {
        ...sessionToJSON(s),
        mcpSessionId,
        hint: `User can watch this browser live at: ${BASE_URL}/vnc/${s.id} — always take a screenshot after actions so you can see results.`,
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("destroy_session", { sessionId: z.string().uuid() }, async ({ sessionId }) => {
    const ok = await destroyBrowserSession(sessionId);
    return { content: [{ type: "text", text: ok ? `Session ${sessionId.slice(0, 8)} destroyed` : "Session not found" }] };
  });

  // ---- Navigation ----------------------------------------------------------

  server.tool("navigate", { url: z.string() }, async ({ url }) => {
    try {
      const page = getPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { content: [{ type: "text", text: `Navigated to: ${await page.title()}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("go_back", {}, async () => {
    try { const p = getPage(); await p.goBack(); return { content: [{ type: "text", text: `Back: ${p.url()}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("go_forward", {}, async () => {
    try { const p = getPage(); await p.goForward(); return { content: [{ type: "text", text: `Forward: ${p.url()}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("reload", {}, async () => {
    try { const p = getPage(); await p.reload(); return { content: [{ type: "text", text: `Reloaded: ${p.url()}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_current_url", {}, async () => {
    try {
      const p = getPage();
      return { content: [{ type: "text", text: JSON.stringify({ url: p.url(), title: await p.title() }) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Interaction ---------------------------------------------------------

  server.tool("click", { selector: z.string() }, async ({ selector }) => {
    try { await getPage().click(selector); return { content: [{ type: "text", text: `Clicked: ${selector}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("fill", { selector: z.string(), value: z.string() }, async ({ selector, value }) => {
    try { await getPage().fill(selector, value); return { content: [{ type: "text", text: `Filled ${selector}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("type", { text: z.string() }, async ({ text }) => {
    try { await getPage().keyboard.type(text); return { content: [{ type: "text", text: `Typed: ${text}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("press_key", { key: z.string() }, async ({ key }) => {
    try { await getPage().keyboard.press(key); return { content: [{ type: "text", text: `Pressed: ${key}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("hover", { selector: z.string() }, async ({ selector }) => {
    try { await getPage().hover(selector); return { content: [{ type: "text", text: `Hovered: ${selector}` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("select_option", { selector: z.string(), value: z.string() }, async ({ selector, value }) => {
    try { await getPage().selectOption(selector, value); return { content: [{ type: "text", text: `Selected "${value}"` }] }; }
    catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Content Extraction --------------------------------------------------

  server.tool("screenshot", {
    selector: z.string().optional().describe("CSS selector to screenshot a specific element"),
    fullPage: z.boolean().optional().default(true).describe("Capture full scrollable page (ignored if selector provided)"),
    ocr: z.boolean().optional().default(false).describe("Extract text via OCR and include in response"),
  }, async ({ selector, fullPage, ocr }) => {
    try {
      const page = getPage();
      const buf = selector
        ? await page.locator(selector).first().screenshot()
        : await page.screenshot({ fullPage });

      const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [
        { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
      ];

      if (ocr) {
        const ocrResult = await runOCR(buf);
        content.push({ type: "text" as const, text: JSON.stringify(ocrResult) });
      }

      return { content };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_html", { selector: z.string().optional() }, async ({ selector }) => {
    try {
      const p = getPage();
      const html = selector ? await p.locator(selector).first().evaluate((el) => el.outerHTML) : await p.content();
      return { content: [{ type: "text", text: html }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_text", { selector: z.string().optional() }, async ({ selector }) => {
    try {
      const p = getPage();
      const text = selector ? await p.locator(selector).first().innerText() : await p.locator("body").innerText();
      return { content: [{ type: "text", text }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_attribute", { selector: z.string(), attribute: z.string() }, async ({ selector, attribute }) => {
    try {
      const val = await getPage().locator(selector).first().getAttribute(attribute);
      return { content: [{ type: "text", text: val ?? "(null)" }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- JavaScript ----------------------------------------------------------

  server.tool("execute_script", { code: z.string() }, async ({ code }) => {
    try {
      const result = await getPage().evaluate(code);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "undefined" }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Logging tools -------------------------------------------------------

  server.tool("get_logs", {
    category: z.enum(["console", "network", "pageerror", "performance", "all"]).optional().default("all"),
    level: z.enum(["debug", "info", "warn", "error", "log", "all"]).optional().default("all"),
    since: z.number().optional().describe("Return logs after this sequence ID (cursor for pagination)"),
    limit: z.number().int().min(1).max(500).optional().default(100),
    urlFilter: z.string().optional().describe("Filter network logs by URL substring"),
  }, async ({ category, level, since, limit, urlFilter }) => {
    try {
      const session = getSession();
      let logs = session.logs.entries;

      if (since !== undefined) logs = logs.filter(e => e.id > since);
      if (category !== "all") logs = logs.filter(e => e.category === category);
      if (level !== "all") logs = logs.filter(e => e.level === level);
      if (urlFilter) logs = logs.filter(e => e.category === "network" && e.message.includes(urlFilter));

      logs = logs.slice(-limit);

      return { content: [{ type: "text", text: JSON.stringify({
        logs,
        cursor: logs.length ? logs[logs.length - 1].id : (since ?? 0),
        total: session.logs.entries.length,
        hint: "Pass 'since' with the cursor value to get only new logs next time",
      }, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  // Backward compatibility
  server.tool("get_console_logs", {}, async () => {
    try {
      const session = getSession();
      const consoleLogs = session.logs.entries
        .filter(e => e.category === "console")
        .slice(-100)
        .map(e => `[${e.level}] ${e.message}`);
      return { content: [{ type: "text", text: consoleLogs.length ? consoleLogs.join("\n") : "(no console logs)" }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("get_errors", {
    since: z.number().optional().describe("Return errors after this sequence ID"),
  }, async ({ since }) => {
    try {
      const session = getSession();
      let errors = session.logs.entries.filter(e =>
        e.category === "pageerror" ||
        e.level === "error" ||
        (e.category === "network" && e.metadata?.status && (e.metadata.status as number) >= 400)
      );
      if (since !== undefined) errors = errors.filter(e => e.id > since);
      errors = errors.slice(-100);

      return { content: [{ type: "text", text: errors.length
        ? JSON.stringify({ errors, cursor: errors[errors.length - 1].id }, null, 2)
        : JSON.stringify({ errors: [], message: "No errors found" })
      }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("get_network_log", {
    urlFilter: z.string().optional(),
    statusFilter: z.number().optional().describe("Filter by HTTP status code"),
    errorsOnly: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional().default(50),
  }, async ({ urlFilter, statusFilter, errorsOnly, limit }) => {
    try {
      const session = getSession();
      let logs = session.logs.entries.filter(e => e.category === "network");

      if (urlFilter) logs = logs.filter(e => e.message.includes(urlFilter));
      if (statusFilter) logs = logs.filter(e => e.metadata?.status === statusFilter);
      if (errorsOnly) logs = logs.filter(e => e.level === "error");

      logs = logs.slice(-limit);
      return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  // ---- Waiting -------------------------------------------------------------

  server.tool("wait_for_selector", { selector: z.string(), timeout: z.number().positive().max(30000).optional() }, async ({ selector, timeout }) => {
    try {
      await getPage().waitForSelector(selector, { timeout: timeout ?? 10000 });
      return { content: [{ type: "text", text: `Found: ${selector}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("wait", { ms: z.number().positive().max(30000) }, async ({ ms }) => {
    await sleep(ms);
    return { content: [{ type: "text", text: `Waited ${ms}ms` }] };
  });

  // ---- Perception tools -----------------------------------------------------

  server.tool("get_accessibility_tree", {
    selector: z.string().optional().describe("CSS selector to scope the tree to a specific element"),
  }, async ({ selector }) => {
    try {
      const page = getPage();
      const locator = selector ? page.locator(selector).first() : page.locator(":root");
      const snapshot = await locator.ariaSnapshot();
      return { content: [{ type: "text", text: snapshot }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("click_at_coordinates", {
    x: z.number().describe("X pixel coordinate"),
    y: z.number().describe("Y pixel coordinate"),
    button: z.enum(["left", "right", "middle"]).optional().default("left"),
    clickCount: z.number().int().min(1).max(3).optional().default(1),
  }, async ({ x, y, button, clickCount }) => {
    try {
      await getPage().mouse.click(x, y, { button, clickCount });
      return { content: [{ type: "text", text: `Clicked at (${x}, ${y}) with ${button} button x${clickCount}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("ocr", {
    structured: z.boolean().optional().default(false).describe("Return word-level bounding boxes with coordinates"),
  }, async ({ structured }) => {
    try {
      const buf = await getPage().screenshot({ fullPage: true });
      const result = await runOCR(buf);
      if (structured) {
        return { content: [{ type: "text", text: JSON.stringify(result.words, null, 2) }] };
      }
      return { content: [{ type: "text", text: result.text }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("drag_and_drop", {
    source: z.string().describe("CSS selector for drag source"),
    target: z.string().describe("CSS selector for drop target"),
  }, async ({ source, target }) => {
    try {
      await getPage().dragAndDrop(source, target);
      return { content: [{ type: "text", text: `Dragged ${source} to ${target}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// CORS
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  next();
});
app.options("*", (_req, res) => res.status(204).end());

// Health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", browserSessions: browserSessions.size, mcpSessions: mcpTransports.size, uptime: process.uptime() });
});

// --- REST API for session management ----------------------------------------

app.post("/api/sessions", async (_req, res) => {
  try {
    const s = await createBrowserSession();
    res.json(sessionToJSON(s));
  } catch (e: unknown) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(Array.from(browserSessions.values()).map(sessionToJSON));
});

app.get("/api/sessions/:id", (req, res) => {
  const s = browserSessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json(sessionToJSON(s));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const ok = await destroyBrowserSession(req.params.id);
  if (!ok) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

// --- SSE log streaming endpoint -----------------------------------------------

app.get("/api/sessions/:id/logs/stream", (req, res) => {
  const session = browserSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send recent logs
  for (const entry of session.logs.entries.slice(-50)) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // Subscribe to new logs
  const listener = (entry: LogEntry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  session.logs.listeners.push(listener);

  req.on("close", () => {
    const idx = session.logs.listeners.indexOf(listener);
    if (idx >= 0) session.logs.listeners.splice(idx, 1);
  });
});

// --- Tunnel key endpoint (for CLI auto-setup) --------------------------------

app.get("/api/tunnel-key", (_req, res) => {
  const paths = ["/home/tunnel/.ssh/tunnel_key", "/data/ssh/tunnel_key", "/app/data/ssh/tunnel_key"];
  for (const p of paths) {
    try {
      const key = readFileSync(p, "utf-8");
      if (key.includes("PRIVATE KEY")) {
        res.type("text/plain").send(key);
        return;
      }
    } catch { /* try next */ }
  }
  res.status(404).json({ error: "Tunnel private key not found. Ensure data/ssh/tunnel_key is mounted." });
});

// --- CLI download endpoint ---------------------------------------------------

app.get("/cli", (_req, res) => {
  try {
    const cli = readFileSync("/app/cli/rembro", "utf-8");
    res.type("text/plain").send(cli);
  } catch {
    res.status(404).send("CLI not found");
  }
});

// --- noVNC viewer page per session ------------------------------------------

app.get("/vnc/:id", (req, res) => {
  const s = browserSessions.get(req.params.id);
  if (!s) return res.status(404).send("Session not found");
  const wsUrl = `wss://${req.headers.host || "rembro.digitalno.de"}/vnc/${s.id}/ws`;
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head>
<title>VNC - ${s.id.slice(0, 8)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; overflow: hidden; }
  #status { position: fixed; top: 0; left: 0; right: 0; background: #161b22; color: #c9d1d9; padding: 8px 16px;
    font-family: system-ui; font-size: 13px; z-index: 100; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #30363d; }
  #status .dot { width: 8px; height: 8px; border-radius: 50%; }
  #status .dot.on { background: #3fb950; } #status .dot.off { background: #f85149; }
  #screen { position: fixed; top: 36px; left: 0; right: 0; bottom: 0; }
  a { color: #58a6ff; }
</style>
</head><body>
<div id="status">
  <span class="dot off" id="dot"></span>
  <span id="state">Connecting...</span>
  <span style="flex:1"></span>
  <span>Session: <code>${s.id.slice(0, 8)}</code></span>
  <a href="/">Dashboard</a>
</div>
<div id="screen"></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
const rfb = new RFB(document.getElementById('screen'), '${wsUrl}');
rfb.scaleViewport = true; rfb.resizeSession = false;
rfb.addEventListener('connect', () => { document.getElementById('dot').className='dot on'; document.getElementById('state').textContent='Connected'; });
rfb.addEventListener('disconnect', () => { document.getElementById('dot').className='dot off'; document.getElementById('state').textContent='Disconnected'; });
</script>
</body></html>`);
});

// Serve noVNC static files
app.use("/novnc", express.static("/usr/share/novnc"));

// --- Landing page / dashboard -----------------------------------------------

app.get("/", (_req, res) => {
  const sessions = Array.from(browserSessions.values()).map(sessionToJSON);
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head><title>RemoteBrowserMCP</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; } h3 { color: #c9d1d9; margin-bottom: 8px; }
  a { color: #58a6ff; } code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; } td, th { padding: 8px 12px; text-align: left; border-bottom: 1px solid #30363d; }
  th { color: #8b949e; font-weight: 500; }
  .btn { display: inline-block; padding: 8px 16px; background: #238636; color: #fff; border: none; border-radius: 6px;
    cursor: pointer; font-size: 14px; text-decoration: none; } .btn:hover { background: #2ea043; }
  .btn-danger { background: #da3633; } .btn-danger:hover { background: #f85149; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
</style>
</head><body>
  <h1>RemoteBrowserMCP</h1>
  <div class="card">
    <span class="dot"></span> <strong>Server Online</strong> &mdash; ${sessions.length} active session(s)
    &nbsp;&nbsp;<button class="btn" onclick="createSession()">+ New Session</button>
  </div>

  <div class="card">
    <h3>Sessions</h3>
    ${sessions.length ? `<table><tr><th>ID</th><th>URL</th><th>Age</th><th>Actions</th></tr>
      ${sessions.map(s => `<tr>
        <td><code>${s.id.slice(0, 8)}</code></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.currentUrl}</td>
        <td>${s.uptime}s</td>
        <td>
          <a class="btn btn-sm" href="${s.vncUrl}" target="_blank">VNC</a>
          <button class="btn btn-sm btn-danger" onclick="deleteSession('${s.id}')">Kill</button>
        </td>
      </tr>`).join("")}
    </table>` : `<p style="color:#8b949e">No active sessions. Click <strong>New Session</strong> to start one.</p>`}
  </div>

  <div class="card">
    <h3>Connect via MCP</h3>
    <p>Add to <code>.mcp.json</code>:</p>
    <pre><code>{
  "mcpServers": {
    "remotebrowser": {
      "type": "http",
      "url": "${BASE_URL}/mcp"
    }
  }
}</code></pre>
  </div>

  <div class="card">
    <h3>REST API</h3>
    <table>
      <tr><td><code>POST /api/sessions</code></td><td>Create a new browser session</td></tr>
      <tr><td><code>GET /api/sessions</code></td><td>List all sessions</td></tr>
      <tr><td><code>GET /api/sessions/:id</code></td><td>Get session details</td></tr>
      <tr><td><code>DELETE /api/sessions/:id</code></td><td>Destroy a session</td></tr>
    </table>
  </div>

<script>
async function createSession() {
  const r = await fetch('/api/sessions', { method: 'POST' });
  const s = await r.json();
  if (s.id) { window.open(s.vncUrl, '_blank'); location.reload(); }
  else alert('Error: ' + JSON.stringify(s));
}
async function deleteSession(id) {
  if (!confirm('Kill session ' + id.slice(0,8) + '?')) return;
  await fetch('/api/sessions/' + id, { method: 'DELETE' });
  location.reload();
}
</script>
</body></html>`);
});

// ---------------------------------------------------------------------------
// MCP transport management
// ---------------------------------------------------------------------------

// Maps MCP session ID -> { transport, mcpServer, browserSessionId }
const mcpTransports = new Map<string, { transport: StreamableHTTPServerTransport; mcpServer: McpServer; browserSessionId: string }>();

app.post("/mcp", async (req, res) => {
  const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (mcpSessionId && mcpTransports.has(mcpSessionId)) {
    const { transport } = mcpTransports.get(mcpSessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New MCP session — auto-create a browser session for it
  const browserSession = await createBrowserSession();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      const mcpServer = createMcpServer(sid, browserSession.id);
      mcpTransports.set(sid, { transport, mcpServer, browserSessionId: browserSession.id });
      mcpServer.connect(transport);
      console.log(`MCP session ${sid.slice(0, 8)} -> browser ${browserSession.id.slice(0, 8)}`);
    },
  });

  transport.onclose = () => {
    for (const [sid, entry] of mcpTransports) {
      if (entry.transport === transport) {
        mcpTransports.delete(sid);
        // Also destroy the browser session
        destroyBrowserSession(entry.browserSessionId);
        break;
      }
    }
  };

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !mcpTransports.has(sid)) return res.status(400).json({ error: "Invalid session" });
  await mcpTransports.get(sid)!.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !mcpTransports.has(sid)) return res.status(400).json({ error: "Invalid session" });
  await mcpTransports.get(sid)!.transport.handleRequest(req, res);
});

// ---------------------------------------------------------------------------
// HTTP server + WebSocket VNC proxy
// ---------------------------------------------------------------------------

const httpServer = createServer(app);

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  // Match /vnc/<session-id>/ws
  const match = req.url?.match(/^\/vnc\/([0-9a-f-]+)\/ws/);
  if (!match) { socket.destroy(); return; }

  const sessionId = match[1];
  const session = browserSessions.get(sessionId);
  if (!session) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Bridge WebSocket <-> TCP to x11vnc
    const tcp = net.connect(session.vncPort, "127.0.0.1");

    tcp.on("connect", () => {
      console.log(`VNC proxy connected for session ${sessionId.slice(0, 8)}`);
    });

    tcp.on("data", (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    ws.on("message", (data) => {
      if (Buffer.isBuffer(data)) tcp.write(data);
      else if (data instanceof ArrayBuffer) tcp.write(Buffer.from(data));
      else tcp.write(Buffer.from(String(data)));
    });

    tcp.on("close", () => ws.close());
    tcp.on("error", () => ws.close());
    ws.on("close", () => tcp.end());
    ws.on("error", () => tcp.end());
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  httpServer.listen(3000, "0.0.0.0", () => {
    console.log("RemoteBrowserMCP server listening on port 3000");
    console.log(`Dashboard: ${BASE_URL}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
