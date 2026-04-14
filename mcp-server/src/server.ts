import express from "express";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { spawn, execFile, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import net from "net";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type BrowserType, type Frame } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";

const BASE_URL = process.env.BASE_URL || "https://rembro.digitalno.de";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 60 * 1000)); // 30 min default
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
// Session Manager — each session gets its own Xvfb, x11vnc, and browser
// ---------------------------------------------------------------------------

interface ViewportConfig {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

const VIEWPORT_PRESETS: Record<string, ViewportConfig> = {
  "iphone-14":     { width: 390,  height: 844,  deviceScaleFactor: 3,     isMobile: true,  hasTouch: true },
  "iphone-14-pro": { width: 393,  height: 852,  deviceScaleFactor: 3,     isMobile: true,  hasTouch: true },
  "pixel-7":       { width: 412,  height: 915,  deviceScaleFactor: 2.625, isMobile: true,  hasTouch: true },
  "ipad-pro":      { width: 1024, height: 1366, deviceScaleFactor: 2,     isMobile: true,  hasTouch: true },
  "desktop-hd":    { width: 1280, height: 720 },
  "desktop-fhd":   { width: 1920, height: 1080 },
  "desktop-2k":    { width: 2560, height: 1440 },
  "desktop-4k":    { width: 3840, height: 2160 },
};

interface DownloadInfo {
  id: number;
  filename: string;
  url: string;
  path: string;
  size: number;
  mimeType: string;
  timestamp: number;
}

interface CreateSessionOpts {
  browser?: "chromium" | "firefox" | "webkit";
  viewport?: { preset?: string } | { device?: string } | { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; userAgent?: string };
  chromeArgs?: string[];
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  colorScheme?: "light" | "dark" | "no-preference";
  locale?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  userAgent?: string;
}

interface BrowserSession {
  id: string;
  displayNum: number;
  vncPort: number;
  browserType: string;
  viewport: ViewportConfig;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  pages: Page[];
  activePageIndex: number;
  logs: SessionLogStore;
  activeFrameSelector?: string; // CSS selector of active iframe, undefined = top-level
  downloads: DownloadInfo[];
  nextDownloadId: number;
  isRecording: boolean;
  harRecordingPath?: string;
  harEntries?: Array<{
    request: { method: string; url: string; headers: Array<{name: string; value: string}>; postData?: { text: string; mimeType: string } };
    response: { status: number; statusText: string; headers: Array<{name: string; value: string}>; content: { size: number; mimeType: string; text?: string } };
    startedDateTime: string;
    time: number;
  }>;
  harRequestHandler?: (request: any) => void;
  harResponseHandler?: (response: any) => void;
  activeRoutes: Array<{ id: number; pattern: string; type: "mock" | "block" }>;
  nextRouteId: number;
  xvfb: ChildProcess;
  x11vnc: ChildProcess;
  createdAt: Date;
  lastActivity: number; // Date.now() — updated on every tool call
}

const browserSessions = new Map<string, BrowserSession>();
let nextDisplayNum = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getBrowserType(name: string): BrowserType {
  switch (name) {
    case "firefox": return firefox;
    case "webkit": return webkit;
    case "chromium":
    default: return chromium;
  }
}

function resolveViewport(opts?: CreateSessionOpts["viewport"]): ViewportConfig {
  if (!opts) return { ...VIEWPORT_PRESETS["desktop-hd"] };

  if ("preset" in opts && opts.preset) {
    const preset = VIEWPORT_PRESETS[opts.preset];
    if (!preset) throw new Error(`Unknown viewport preset: ${opts.preset}. Available: ${Object.keys(VIEWPORT_PRESETS).join(", ")}`);
    return { ...preset };
  }

  if ("device" in opts && opts.device) {
    const preset = VIEWPORT_PRESETS[opts.device];
    if (!preset) throw new Error(`Unknown device: ${opts.device}. Available: ${Object.keys(VIEWPORT_PRESETS).join(", ")}`);
    return { ...preset };
  }

  if ("width" in opts && "height" in opts) {
    return { width: opts.width, height: opts.height, deviceScaleFactor: opts.deviceScaleFactor, isMobile: opts.isMobile, hasTouch: opts.hasTouch, userAgent: opts.userAgent };
  }

  return { ...VIEWPORT_PRESETS["desktop-hd"] };
}

async function createBrowserSession(opts: CreateSessionOpts = {}): Promise<BrowserSession> {
  const id = randomUUID();
  const displayNum = nextDisplayNum++;
  const vncPort = 5900 + displayNum; // e.g. display :100 -> port 6000

  const browserTypeName = opts.browser ?? "chromium";
  const browserType = getBrowserType(browserTypeName);
  const viewport = resolveViewport(opts.viewport);

  // Xvfb resolution: at least 1920x1080, or match viewport if larger
  const xvfbWidth = Math.max(viewport.width, 1920);
  const xvfbHeight = Math.max(viewport.height, 1080);

  // Start Xvfb
  const xvfb = spawn("Xvfb", [`:${displayNum}`, "-screen", "0", `${xvfbWidth}x${xvfbHeight}x24`, "-ac"], {
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

  // Build browser launch args
  const launchArgs: string[] = [];
  if (browserTypeName === "chromium") {
    launchArgs.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu");
    if (opts.chromeArgs) launchArgs.push(...opts.chromeArgs);
  }

  // Launch browser on this display
  const browser = await browserType.launch({
    headless: false,
    args: launchArgs.length > 0 ? launchArgs : undefined,
    proxy: opts.proxy ? { server: opts.proxy.server, bypass: opts.proxy.bypass, username: opts.proxy.username, password: opts.proxy.password } : undefined,
    env: { ...process.env, DISPLAY: `:${displayNum}` } as Record<string, string>,
  });

  const contextOpts: Record<string, unknown> = {
    viewport: { width: viewport.width, height: viewport.height },
  };
  if (viewport.deviceScaleFactor) contextOpts.deviceScaleFactor = viewport.deviceScaleFactor;
  if (viewport.isMobile) contextOpts.isMobile = viewport.isMobile;
  if (viewport.hasTouch) contextOpts.hasTouch = viewport.hasTouch;
  if (opts.colorScheme) contextOpts.colorScheme = opts.colorScheme;
  if (opts.locale) contextOpts.locale = opts.locale;
  if (opts.timezoneId) contextOpts.timezoneId = opts.timezoneId;
  if (opts.geolocation) contextOpts.geolocation = opts.geolocation;
  if (opts.userAgent || viewport.userAgent) contextOpts.userAgent = opts.userAgent ?? viewport.userAgent;

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  const session: BrowserSession = {
    id,
    displayNum,
    vncPort,
    browserType: browserTypeName,
    viewport,
    browser,
    context,
    page,
    pages: [page],
    activePageIndex: 0,
    logs: createLogStore(),
    downloads: [],
    nextDownloadId: 1,
    isRecording: false,
    activeRoutes: [],
    nextRouteId: 1,
    xvfb,
    x11vnc,
    createdAt: new Date(),
    lastActivity: Date.now(),
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

    p.on("download", async (download) => {
      const filename = download.suggestedFilename();
      const savePath = `/tmp/downloads/${session.id}/${filename}`;
      try {
        mkdirSync(`/tmp/downloads/${session.id}`, { recursive: true });
        await download.saveAs(savePath);
        const stat = statSync(savePath);
        session.downloads.push({
          id: session.nextDownloadId++,
          filename,
          url: download.url(),
          path: savePath,
          size: stat.size,
          mimeType: "",
          timestamp: Date.now(),
        });
      } catch (e) {
        console.log(`Download failed: ${filename} — ${(e as Error).message}`);
      }
    });
  };

  wirePageLogListeners(page);

  context.on("page", (newPage) => {
    session.pages.push(newPage);
    wirePageLogListeners(newPage);
  });

  browserSessions.set(id, session);
  console.log(`Session ${id.slice(0, 8)} created (${browserTypeName}, display :${displayNum}, vnc port ${vncPort}, viewport ${viewport.width}x${viewport.height})`);
  return session;
}

async function destroyBrowserSession(id: string): Promise<boolean> {
  const session = browserSessions.get(id);
  if (!session) return false;

  // Remove from map immediately so concurrent calls don't double-destroy
  browserSessions.delete(id);

  // Close all open pages
  for (const p of session.pages) {
    try { if (!p.isClosed()) await p.close().catch(() => {}); } catch {}
  }

  // Close browser with a timeout — browser.close() can hang if Chromium is unresponsive
  try {
    await Promise.race([
      session.browser.close(),
      sleep(5000),
    ]);
  } catch {}

  // Kill child processes with SIGKILL to ensure they die
  try { session.x11vnc.kill("SIGKILL"); } catch {}
  try { session.xvfb.kill("SIGKILL"); } catch {}

  // Clean up downloads
  try { rmSync(`/tmp/downloads/${id}`, { recursive: true, force: true }); } catch {}

  // Clean up HAR recording file
  if (session.harRecordingPath) {
    try { rmSync(session.harRecordingPath, { force: true }); } catch {}
  }

  console.log(`Session ${id.slice(0, 8)} destroyed`);
  return true;
}

// Auto-cleanup stale sessions every 60s
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of browserSessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`Session ${id.slice(0, 8)} expired (inactive for ${Math.floor((now - session.lastActivity) / 1000)}s)`);
      destroyBrowserSession(id);
    }
  }
}, 60_000);

function sessionToJSON(s: BrowserSession) {
  return {
    id: s.id,
    browserType: s.browserType,
    viewport: { width: s.viewport.width, height: s.viewport.height, deviceScaleFactor: s.viewport.deviceScaleFactor, isMobile: s.viewport.isMobile },
    vncUrl: `${BASE_URL}/vnc/${s.id}`,
    currentUrl: s.page.isClosed() ? "(closed)" : s.page.url(),
    createdAt: s.createdAt.toISOString(),
    uptime: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
    idleSeconds: Math.floor((Date.now() - s.lastActivity) / 1000),
  };
}

// ---------------------------------------------------------------------------
// MCP server factory — tools scoped to a browser session
// ---------------------------------------------------------------------------

function createMcpServer(mcpSessionId: string, browserSessionId: string): McpServer {
  const server = new McpServer({ name: "remotebrowser-mcp", version: "0.3.0" });

  const getSession = (): BrowserSession => {
    const s = browserSessions.get(browserSessionId);
    if (!s) throw new Error("Browser session not found");
    s.lastActivity = Date.now();
    return s;
  };
  const getPage = (): Page => {
    const s = getSession();
    if (s.page.isClosed()) throw new Error("Page is closed");
    return s.page;
  };

  const resolveFrame = async (frameSelector?: string): Promise<Frame> => {
    const page = getPage();
    if (!frameSelector) return page.mainFrame();
    const elementHandle = await page.locator(frameSelector).first().elementHandle();
    if (!elementHandle) throw new Error(`iframe not found: ${frameSelector}`);
    const frame = await elementHandle.contentFrame();
    if (!frame) throw new Error(`Could not access frame content for: ${frameSelector}`);
    return frame;
  };

  const getActiveFrame = async (): Promise<Frame> => {
    const session = getSession();
    return resolveFrame(session.activeFrameSelector);
  };

  // ---- Session management --------------------------------------------------

  server.tool("create_session", {
    browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe("Browser engine to use (default: chromium)"),
    viewport_preset: z.string().optional().describe("Viewport preset name (e.g. iphone-14, desktop-fhd)"),
    viewport_device: z.string().optional().describe("Device name for viewport (alias for preset)"),
    viewport_width: z.number().int().positive().optional().describe("Custom viewport width in pixels"),
    viewport_height: z.number().int().positive().optional().describe("Custom viewport height in pixels"),
    viewport_scale: z.number().positive().optional().describe("Device scale factor"),
    viewport_mobile: z.boolean().optional().describe("Emulate mobile device"),
    viewport_touch: z.boolean().optional().describe("Enable touch events"),
    chrome_args: z.array(z.string()).optional().describe("Extra Chrome launch arguments"),
    proxy_server: z.string().optional().describe("Proxy server URL"),
    proxy_bypass: z.string().optional().describe("Proxy bypass list"),
    proxy_username: z.string().optional().describe("Proxy auth username"),
    proxy_password: z.string().optional().describe("Proxy auth password"),
    color_scheme: z.enum(["light", "dark", "no-preference"]).optional().describe("Preferred color scheme"),
    locale: z.string().optional().describe("Browser locale (e.g. en-US)"),
    timezone_id: z.string().optional().describe("Timezone (e.g. America/New_York)"),
    geo_latitude: z.number().optional().describe("Geolocation latitude"),
    geo_longitude: z.number().optional().describe("Geolocation longitude"),
    geo_accuracy: z.number().optional().describe("Geolocation accuracy in meters"),
    user_agent: z.string().optional().describe("Custom user agent string"),
  }, async (params) => {
    try {
      const opts: CreateSessionOpts = {};
      if (params.browser) opts.browser = params.browser;
      if (params.viewport_preset) {
        opts.viewport = { preset: params.viewport_preset };
      } else if (params.viewport_device) {
        opts.viewport = { device: params.viewport_device };
      } else if (params.viewport_width && params.viewport_height) {
        opts.viewport = {
          width: params.viewport_width,
          height: params.viewport_height,
          deviceScaleFactor: params.viewport_scale,
          isMobile: params.viewport_mobile,
          hasTouch: params.viewport_touch,
        };
      }
      if (params.chrome_args) opts.chromeArgs = params.chrome_args;
      if (params.proxy_server) {
        opts.proxy = { server: params.proxy_server, bypass: params.proxy_bypass, username: params.proxy_username, password: params.proxy_password };
      }
      if (params.color_scheme) opts.colorScheme = params.color_scheme;
      if (params.locale) opts.locale = params.locale;
      if (params.timezone_id) opts.timezoneId = params.timezone_id;
      if (params.geo_latitude !== undefined && params.geo_longitude !== undefined) {
        opts.geolocation = { latitude: params.geo_latitude, longitude: params.geo_longitude, accuracy: params.geo_accuracy };
      }
      if (params.user_agent) opts.userAgent = params.user_agent;

      const s = await createBrowserSession(opts);
      return { content: [{ type: "text", text: JSON.stringify(sessionToJSON(s), null, 2) }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  server.tool("list_sessions", {}, async () => {
    const list = Array.from(browserSessions.values()).map(sessionToJSON);
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool("list_viewport_presets", {}, async () => {
    const presets = Object.entries(VIEWPORT_PRESETS).map(([name, config]) => ({ name, ...config }));
    return { content: [{ type: "text", text: JSON.stringify(presets, null, 2) }] };
  });

  server.tool("set_viewport", {
    preset: z.string().optional().describe("Viewport preset name"),
    width: z.number().int().positive().optional().describe("Custom width in pixels"),
    height: z.number().int().positive().optional().describe("Custom height in pixels"),
  }, async (params) => {
    try {
      const s = getSession();
      let width: number;
      let height: number;
      if (params.preset) {
        const preset = VIEWPORT_PRESETS[params.preset];
        if (!preset) throw new Error(`Unknown preset: ${params.preset}. Available: ${Object.keys(VIEWPORT_PRESETS).join(", ")}`);
        width = preset.width;
        height = preset.height;
        s.viewport = { ...preset };
      } else if (params.width && params.height) {
        width = params.width;
        height = params.height;
        s.viewport = { width, height };
      } else {
        throw new Error("Provide either a preset name or both width and height");
      }
      await s.page.setViewportSize({ width, height });
      return { content: [{ type: "text", text: `Viewport set to ${width}x${height}` }] };
    } catch (e: unknown) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
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
    try {
      const frame = await getActiveFrame();
      await frame.locator(selector).click();
      return { content: [{ type: "text", text: `Clicked: ${selector}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("fill", { selector: z.string(), value: z.string() }, async ({ selector, value }) => {
    try {
      const frame = await getActiveFrame();
      await frame.locator(selector).fill(value);
      return { content: [{ type: "text", text: `Filled ${selector}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
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
    try {
      const frame = await getActiveFrame();
      await frame.locator(selector).hover();
      return { content: [{ type: "text", text: `Hovered: ${selector}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("select_option", { selector: z.string(), value: z.string() }, async ({ selector, value }) => {
    try {
      const frame = await getActiveFrame();
      await frame.locator(selector).selectOption(value);
      return { content: [{ type: "text", text: `Selected "${value}"` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- iframe support -------------------------------------------------------

  server.tool("list_frames", {}, async () => {
    try {
      const page = getPage();
      const frames = page.frames();
      const frameInfos = frames.map((f, i) => ({
        index: i,
        name: f.name() || "(unnamed)",
        url: f.url(),
        isMain: f === page.mainFrame(),
        isDetached: f.isDetached(),
      }));
      return { content: [{ type: "text", text: JSON.stringify(frameInfos, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("switch_frame", {
    selector: z.string().optional().describe("CSS selector of the <iframe> element. Omit to return to main frame."),
  }, async ({ selector }) => {
    try {
      const session = getSession();
      if (!selector) {
        session.activeFrameSelector = undefined;
        return { content: [{ type: "text", text: "Switched to main frame" }] };
      }
      // Verify the iframe exists and is accessible
      const page = getPage();
      const elementHandle = await page.locator(selector).first().elementHandle();
      if (!elementHandle) throw new Error(`iframe not found: ${selector}`);
      const frame = await elementHandle.contentFrame();
      if (!frame) throw new Error(`Could not access frame content for: ${selector}`);
      session.activeFrameSelector = selector;
      return { content: [{ type: "text", text: `Switched to frame: ${selector} (${frame.url()})` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("frame_click", {
    frame: z.string().describe("CSS selector of the <iframe> element"),
    selector: z.string().describe("CSS selector inside the frame"),
  }, async ({ frame, selector }) => {
    try {
      const f = await resolveFrame(frame);
      await f.locator(selector).click();
      return { content: [{ type: "text", text: `Clicked ${selector} in frame ${frame}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("frame_fill", {
    frame: z.string().describe("CSS selector of the <iframe> element"),
    selector: z.string().describe("CSS selector inside the frame"),
    value: z.string(),
  }, async ({ frame, selector, value }) => {
    try {
      const f = await resolveFrame(frame);
      await f.locator(selector).fill(value);
      return { content: [{ type: "text", text: `Filled ${selector} in frame ${frame}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("frame_get_text", {
    frame: z.string().describe("CSS selector of the <iframe> element"),
    selector: z.string().optional().describe("CSS selector inside the frame (default: body)"),
  }, async ({ frame, selector }) => {
    try {
      const f = await resolveFrame(frame);
      const text = await f.locator(selector || "body").innerText();
      return { content: [{ type: "text", text }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("frame_get_html", {
    frame: z.string().describe("CSS selector of the <iframe> element"),
    selector: z.string().optional().describe("CSS selector inside the frame"),
  }, async ({ frame, selector }) => {
    try {
      const f = await resolveFrame(frame);
      const html = selector
        ? await f.locator(selector).first().evaluate((el) => el.outerHTML)
        : await f.content();
      return { content: [{ type: "text", text: html }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
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
      const frame = await getActiveFrame();
      const html = selector ? await frame.locator(selector).first().evaluate((el) => el.outerHTML) : await frame.content();
      return { content: [{ type: "text", text: html }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_text", { selector: z.string().optional() }, async ({ selector }) => {
    try {
      const frame = await getActiveFrame();
      const text = selector ? await frame.locator(selector).first().innerText() : await frame.locator("body").innerText();
      return { content: [{ type: "text", text }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_attribute", { selector: z.string(), attribute: z.string() }, async ({ selector, attribute }) => {
    try {
      const frame = await getActiveFrame();
      const val = await frame.locator(selector).first().getAttribute(attribute);
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

  // ---- Cookie Management ----------------------------------------------------

  server.tool("get_cookies", {
    urls: z.array(z.string()).optional().describe("Filter cookies by URLs"),
  }, async ({ urls }) => {
    try {
      const ctx = getSession().context;
      const cookies = urls ? await ctx.cookies(urls) : await ctx.cookies();
      return { content: [{ type: "text", text: JSON.stringify(cookies, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("set_cookies", {
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string().optional(),
      path: z.string().optional().default("/"),
      expires: z.number().optional(),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
      url: z.string().optional(),
    })),
  }, async ({ cookies }) => {
    try {
      await getSession().context.addCookies(cookies);
      return { content: [{ type: "text", text: `Set ${cookies.length} cookie(s)` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("clear_cookies", {}, async () => {
    try {
      await getSession().context.clearCookies();
      return { content: [{ type: "text", text: "Cookies cleared" }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Storage Management ---------------------------------------------------

  server.tool("get_storage", {
    type: z.enum(["localStorage", "sessionStorage"]).default("localStorage"),
    keys: z.array(z.string()).optional().describe("Specific keys to retrieve (omit for all)"),
  }, async ({ type, keys }) => {
    try {
      const page = getPage();
      const data = await page.evaluate(({ storageType, filterKeys }) => {
        const storage = storageType === "localStorage" ? localStorage : sessionStorage;
        const result: Record<string, string> = {};
        if (filterKeys) {
          for (const key of filterKeys) {
            const val = storage.getItem(key);
            if (val !== null) result[key] = val;
          }
        } else {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i)!;
            result[key] = storage.getItem(key)!;
          }
        }
        return result;
      }, { storageType: type, filterKeys: keys });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("set_storage", {
    type: z.enum(["localStorage", "sessionStorage"]).default("localStorage"),
    entries: z.record(z.string(), z.string()).describe("Key-value pairs to set"),
  }, async ({ type, entries }) => {
    try {
      const page = getPage();
      await page.evaluate(({ storageType, data }) => {
        const storage = storageType === "localStorage" ? localStorage : sessionStorage;
        for (const [key, value] of Object.entries(data) as [string, string][]) {
          storage.setItem(key, value);
        }
      }, { storageType: type, data: entries });
      return { content: [{ type: "text", text: `Set ${Object.keys(entries).length} ${type} entries` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Multi-Tab / Multi-Page -----------------------------------------------

  server.tool("list_pages", {}, async () => {
    try {
      const session = getSession();
      const pages: { index: number; url: string; title: string; isActive: boolean }[] = [];
      for (let i = 0; i < session.pages.length; i++) {
        const p = session.pages[i];
        if (p.isClosed()) {
          pages.push({ index: i, url: "(closed)", title: "(closed)", isActive: i === session.activePageIndex });
        } else {
          let title = "";
          try { title = await p.title(); } catch { title = "(error)"; }
          pages.push({ index: i, url: p.url(), title, isActive: i === session.activePageIndex });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(pages, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("switch_page", {
    index: z.number().int().min(0).describe("Page index to switch to"),
  }, async ({ index }) => {
    try {
      const session = getSession();
      if (index >= session.pages.length || session.pages[index].isClosed()) {
        throw new Error(`Page ${index} not available`);
      }
      session.activePageIndex = index;
      session.page = session.pages[index];
      const url = session.page.url();
      return { content: [{ type: "text", text: `Switched to page ${index}: ${url}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("new_page", {
    url: z.string().optional().describe("URL to navigate to (omit for blank page)"),
  }, async ({ url }) => {
    try {
      const session = getSession();
      const newPage = await session.context.newPage();
      session.pages.push(newPage);
      session.activePageIndex = session.pages.length - 1;
      session.page = newPage;
      newPage.on("console", (msg) => {
        addLog(session.logs, { category: "console", level: msg.type() as LogEntry["level"], message: msg.text(), metadata: { location: msg.location() } });
      });
      if (url) await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { content: [{ type: "text", text: `New page created (index ${session.pages.length - 1})${url ? `: ${url}` : ""}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("close_page", {
    index: z.number().int().min(0).optional().describe("Page index to close (defaults to active page)"),
  }, async ({ index }) => {
    try {
      const session = getSession();
      const target = index ?? session.activePageIndex;
      if (target >= session.pages.length) throw new Error(`Page ${target} not found`);
      if (session.pages.length <= 1) throw new Error("Cannot close the last page");

      await session.pages[target].close();
      session.pages.splice(target, 1);

      if (session.activePageIndex >= session.pages.length) {
        session.activePageIndex = session.pages.length - 1;
      }
      session.page = session.pages[session.activePageIndex];

      return { content: [{ type: "text", text: `Closed page ${target}. Active page is now ${session.activePageIndex}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- Auth State Save/Restore ----------------------------------------------

  server.tool("save_auth_state", {}, async () => {
    try {
      const session = getSession();
      const state = await session.context.storageState();
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("restore_auth_state", {
    state: z.string().describe("JSON string of auth state from save_auth_state"),
  }, async ({ state }) => {
    try {
      const session = getSession();
      const parsed = JSON.parse(state);
      const browser = session.browser;
      if (!browser) throw new Error("Cannot restore auth state on persistent context sessions");

      // Close old context
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});

      // Create new context with saved state
      const newContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        storageState: parsed,
      });
      const newPage = await newContext.newPage();

      session.context = newContext;
      session.page = newPage;
      session.pages = [newPage];
      session.activePageIndex = 0;

      newPage.on("console", (msg) => {
        addLog(session.logs, { category: "console", level: msg.type() as LogEntry["level"], message: msg.text(), metadata: { location: msg.location() } });
      });
      newContext.on("page", (p) => {
        session.pages.push(p);
        p.on("console", (msg) => {
          addLog(session.logs, { category: "console", level: msg.type() as LogEntry["level"], message: msg.text(), metadata: { location: msg.location() } });
        });
      });

      return { content: [{ type: "text", text: "Auth state restored. New context created with saved cookies and storage." }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---- File downloads -------------------------------------------------------

  server.tool("get_downloads", {}, async () => {
    try {
      const session = getSession();
      return { content: [{ type: "text", text: JSON.stringify(session.downloads, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_download_content", {
    id: z.number().int().describe("Download ID from get_downloads"),
    encoding: z.enum(["base64", "text"]).optional().default("base64").describe("Encoding for the file content"),
  }, async ({ id, encoding }) => {
    try {
      const session = getSession();
      const dl = session.downloads.find(d => d.id === id);
      if (!dl) throw new Error(`Download ${id} not found`);

      const buf = readFileSync(dl.path);

      if (encoding === "text") {
        return { content: [{ type: "text", text: buf.toString("utf-8") }] };
      }
      // Return as base64 — check if it looks like an image
      const ext = dl.filename.split(".").pop()?.toLowerCase();
      const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
      if (imageExts.includes(ext || "")) {
        const mimeMap: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
        return { content: [{ type: "image", data: buf.toString("base64"), mimeType: mimeMap[ext!] || "application/octet-stream" }] };
      }
      return { content: [{ type: "text", text: buf.toString("base64") }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("wait_for_download", {
    action: z.enum(["click"]).describe("Action to trigger the download"),
    selector: z.string().describe("CSS selector for the element to interact with"),
    timeout: z.number().int().positive().max(30000).optional().default(10000).describe("Timeout in ms to wait for the download"),
  }, async ({ action, selector, timeout }) => {
    try {
      const page = getPage();
      const session = getSession();

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout }),
        page.click(selector),
      ]);

      const filename = download.suggestedFilename();
      const savePath = `/tmp/downloads/${session.id}/${filename}`;
      mkdirSync(`/tmp/downloads/${session.id}`, { recursive: true });
      await download.saveAs(savePath);

      const stat = statSync(savePath);
      const info: DownloadInfo = {
        id: session.nextDownloadId++,
        filename,
        url: download.url(),
        path: savePath,
        size: stat.size,
        mimeType: "",
        timestamp: Date.now(),
      };
      session.downloads.push(info);

      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---------------------------------------------------------------------------
  // HAR recording & network capture tools
  // ---------------------------------------------------------------------------

  server.tool("start_har_recording", {}, async () => {
    try {
      const session = getSession();
      if (session.isRecording) throw new Error("Already recording");

      const harPath = `/tmp/har/${session.id}-${Date.now()}.har`;
      mkdirSync("/tmp/har", { recursive: true });

      const harEntries: NonNullable<BrowserSession["harEntries"]> = [];
      const requestTimings = new Map<string, number>();

      const requestHandler = (request: any) => {
        requestTimings.set(request.url() + request.method(), Date.now());
      };

      const responseHandler = async (response: any) => {
        try {
          const startTime = requestTimings.get(response.url() + response.request().method()) || Date.now();
          const reqHeaders = Object.entries(response.request().headers()).map(([name, value]) => ({ name, value: value as string }));
          const resHeaders = Object.entries(response.headers()).map(([name, value]) => ({ name, value: value as string }));

          let bodyText: string | undefined;
          const mimeType = response.headers()["content-type"] || "";
          try {
            if (mimeType.includes("json") || mimeType.includes("text") || mimeType.includes("xml") || mimeType.includes("javascript") || mimeType.includes("css")) {
              const body = await response.body();
              bodyText = body.toString("utf-8").slice(0, 50000);
            }
          } catch {}

          harEntries.push({
            startedDateTime: new Date(startTime).toISOString(),
            time: Date.now() - startTime,
            request: {
              method: response.request().method(),
              url: response.url(),
              headers: reqHeaders,
              ...(response.request().postData() ? { postData: { text: response.request().postData()!, mimeType: response.request().headers()["content-type"] || "" } } : {}),
            },
            response: {
              status: response.status(),
              statusText: response.statusText(),
              headers: resHeaders,
              content: {
                size: parseInt(response.headers()["content-length"] || "0") || 0,
                mimeType,
                ...(bodyText ? { text: bodyText } : {}),
              },
            },
          });
        } catch {}
      };

      session.harEntries = harEntries;
      session.harRequestHandler = requestHandler;
      session.harResponseHandler = responseHandler;

      for (const p of session.pages) {
        if (!p.isClosed()) {
          p.on("request", requestHandler);
          p.on("response", responseHandler);
        }
      }

      session.isRecording = true;
      session.harRecordingPath = harPath;

      return { content: [{ type: "text", text: "HAR recording started. Use stop_har_recording to get the HAR file." }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("stop_har_recording", {
    format: z.enum(["full", "summary"]).optional().default("full"),
  }, async ({ format }) => {
    try {
      const session = getSession();
      if (!session.isRecording) throw new Error("Not recording");

      const harEntries = session.harEntries || [];
      const requestHandler = session.harRequestHandler;
      const responseHandler = session.harResponseHandler;

      for (const p of session.pages) {
        if (!p.isClosed()) {
          if (requestHandler) p.removeListener("request", requestHandler);
          if (responseHandler) p.removeListener("response", responseHandler);
        }
      }

      session.isRecording = false;
      session.harEntries = undefined;
      session.harRequestHandler = undefined;
      session.harResponseHandler = undefined;

      if (format === "summary") {
        const summary = harEntries.map((e) => ({
          method: e.request.method,
          url: e.request.url,
          status: e.response.status,
          size: e.response.content.size,
          time: e.time,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      const har = {
        log: {
          version: "1.2",
          creator: { name: "rembro", version: "0.3.0" },
          entries: harEntries,
        },
      };

      if (session.harRecordingPath) {
        writeFileSync(session.harRecordingPath, JSON.stringify(har, null, 2));
      }

      return { content: [{ type: "text", text: JSON.stringify(har, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("get_response_body", {
    url: z.string().describe("URL pattern to match (substring match)"),
    timeout: z.number().int().positive().max(30000).optional().default(10000),
  }, async ({ url, timeout }) => {
    try {
      const page = getPage();

      const response = await page.waitForResponse(
        (resp: any) => resp.url().includes(url),
        { timeout }
      );

      const status = response.status();
      const headers = response.headers();
      let body: string;
      try {
        const buf = await response.body();
        const contentType = headers["content-type"] || "";
        if (contentType.includes("json") || contentType.includes("text") || contentType.includes("xml")) {
          body = buf.toString("utf-8");
        } else {
          body = buf.toString("base64");
        }
      } catch {
        body = "(body unavailable)";
      }

      return { content: [{ type: "text", text: JSON.stringify({ url: response.url(), status, headers, body }, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---------------------------------------------------------------------------
  // Network interception / mocking
  // ---------------------------------------------------------------------------

  server.tool("mock_route", {
    pattern: z.string().describe("URL pattern to match (glob, e.g. '**/api/users*')"),
    status: z.number().int().optional().default(200),
    body: z.string().describe("Response body (JSON string, HTML, or plain text)"),
    contentType: z.string().optional().default("application/json"),
    headers: z.record(z.string(), z.string()).optional(),
  }, async ({ pattern, status, body, contentType, headers }) => {
    try {
      const page = getPage();
      const session = getSession();

      await page.route(pattern, (route) => {
        route.fulfill({
          status,
          body,
          contentType,
          headers: headers ?? {},
        });
      });

      const routeId = session.nextRouteId++;
      session.activeRoutes.push({ id: routeId, pattern, type: "mock" });

      return { content: [{ type: "text", text: `Route #${routeId} mocked: ${pattern} → ${status} ${contentType}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("block_route", {
    pattern: z.string().describe("URL pattern to block (glob, e.g. '**/*.png' or '**/analytics*')"),
  }, async ({ pattern }) => {
    try {
      const page = getPage();
      const session = getSession();

      await page.route(pattern, (route) => {
        route.abort();
      });

      const routeId = session.nextRouteId++;
      session.activeRoutes.push({ id: routeId, pattern, type: "block" });

      return { content: [{ type: "text", text: `Route #${routeId} blocked: ${pattern}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("list_routes", {}, async () => {
    try {
      const session = getSession();
      return { content: [{ type: "text", text: JSON.stringify(session.activeRoutes, null, 2) }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  server.tool("clear_routes", {}, async () => {
    try {
      const page = getPage();
      const session = getSession();

      await page.unrouteAll({ behavior: "wait" });

      const count = session.activeRoutes.length;
      session.activeRoutes = [];

      return { content: [{ type: "text", text: `Cleared ${count} route(s)` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true }; }
  });

  // ---------------------------------------------------------------------------
  // PDF generation (via CDP for headed Chromium)
  // ---------------------------------------------------------------------------

  server.tool("save_pdf", {
    format: z.enum(["A4", "Letter", "Legal", "A3"]).optional().default("A4"),
    landscape: z.boolean().optional().default(false),
    printBackground: z.boolean().optional().default(true),
    scale: z.number().min(0.1).max(2).optional().default(1),
    margin: z.object({
      top: z.string().optional().default("0.5in"),
      bottom: z.string().optional().default("0.5in"),
      left: z.string().optional().default("0.5in"),
      right: z.string().optional().default("0.5in"),
    }).optional(),
  }, async ({ format, landscape, printBackground, scale, margin }) => {
    try {
      const page = getPage();
      const session = getSession();

      if (session.browserType !== "chromium") {
        return { content: [{ type: "text", text: "PDF generation is only supported with Chromium browser" }], isError: true };
      }

      const parseMarginInches = (val: string): number => {
        const num = parseFloat(val);
        if (isNaN(num)) return 0.5;
        return num;
      };

      const paperDimensions: Record<string, { width: number; height: number }> = {
        A4: { width: 8.27, height: 11.69 },
        A3: { width: 11.69, height: 16.54 },
        Letter: { width: 8.5, height: 11 },
        Legal: { width: 8.5, height: 14 },
      };
      const paper = paperDimensions[format] || paperDimensions.A4;

      const cdpSession = await page.context().newCDPSession(page);
      const result = await cdpSession.send("Page.printToPDF", {
        landscape,
        printBackground,
        scale,
        paperWidth: paper.width,
        paperHeight: paper.height,
        marginTop: parseMarginInches(margin?.top || "0.5in"),
        marginBottom: parseMarginInches(margin?.bottom || "0.5in"),
        marginLeft: parseMarginInches(margin?.left || "0.5in"),
        marginRight: parseMarginInches(margin?.right || "0.5in"),
      });
      await cdpSession.detach();

      return { content: [{ type: "text", text: `data:application/pdf;base64,${(result as any).data}` }] };
    } catch (e: unknown) { return { content: [{ type: "text", text: `Error generating PDF: ${(e as Error).message}. PDF generation requires Chromium.` }], isError: true }; }
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

app.post("/api/sessions", async (req, res) => {
  try {
    const body = req.body ?? {};
    const opts: CreateSessionOpts = {};
    if (body.browser) opts.browser = body.browser;
    if (body.viewport) opts.viewport = body.viewport;
    if (body.chromeArgs) opts.chromeArgs = body.chromeArgs;
    if (body.proxy) opts.proxy = body.proxy;
    if (body.colorScheme) opts.colorScheme = body.colorScheme;
    if (body.locale) opts.locale = body.locale;
    if (body.timezoneId) opts.timezoneId = body.timezoneId;
    if (body.geolocation) opts.geolocation = body.geolocation;
    if (body.userAgent) opts.userAgent = body.userAgent;

    const s = await createBrowserSession(opts);
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

app.delete("/api/sessions", async (_req, res) => {
  const ids = Array.from(browserSessions.keys());
  await Promise.all(ids.map((id) => destroyBrowserSession(id)));
  res.json({ ok: true, destroyed: ids.length });
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

// --- API documentation ------------------------------------------------------

app.get("/api.md", (_req, res) => {
  const paths = ["/app/API.md", "../API.md", "./API.md"];
  for (const p of paths) {
    try {
      const md = readFileSync(p, "utf-8");
      res.type("text/markdown").send(md);
      return;
    } catch { /* try next */ }
  }
  res.status(404).send("API.md not found");
});

app.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head><title>Rembro API Docs</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
  h1, h2, h3, h4 { color: #58a6ff; margin-top: 1.5em; }
  h1 { border-bottom: 1px solid #30363d; padding-bottom: 0.3em; }
  h2 { border-bottom: 1px solid #30363d; padding-bottom: 0.3em; }
  a { color: #58a6ff; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: #f0883e; }
  pre { background: #161b22; padding: 16px; border-radius: 6px; overflow-x: auto; border: 1px solid #30363d; }
  pre code { background: transparent; padding: 0; color: #c9d1d9; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th, td { padding: 8px 12px; text-align: left; border: 1px solid #30363d; }
  th { background: #161b22; color: #8b949e; }
  blockquote { border-left: 3px solid #58a6ff; padding-left: 1em; color: #8b949e; margin: 1em 0; }
  hr { border: 0; border-top: 1px solid #30363d; margin: 2em 0; }
  .nav { position: sticky; top: 0; background: #0d1117; padding: 12px 0; margin-bottom: 20px; border-bottom: 1px solid #30363d; }
  .nav a { margin-right: 16px; }
  #content img { max-width: 100%; }
</style>
</head><body>
<div class="nav">
  <a href="/">&larr; Dashboard</a>
  <a href="/api.md">Raw Markdown</a>
  <a href="https://github.com/trajche/rembro">GitHub</a>
</div>
<div id="content">Loading…</div>
<script type="module">
  import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";
  const res = await fetch("/api.md");
  const md = await res.text();
  document.getElementById("content").innerHTML = marked.parse(md);
</script>
</body></html>`);
});

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
    ${sessions.length ? `&nbsp;<button class="btn btn-danger" onclick="killAllSessions()">Kill All</button>` : ""}
  </div>

  <div class="card">
    <h3>Sessions</h3>
    ${sessions.length ? `<table><tr><th>ID</th><th>Browser</th><th>URL</th><th>Idle</th><th>Actions</th></tr>
      ${sessions.map(s => `<tr>
        <td><code>${s.id.slice(0, 8)}</code></td>
        <td>${s.browserType || "chromium"}</td>
        <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.currentUrl}</td>
        <td>${s.idleSeconds}s</td>
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
    <h3>API Documentation</h3>
    <p>Full API reference with payload examples for all 60 MCP tools + REST endpoints:</p>
    <p>
      <a class="btn" href="/docs">Browse API Docs</a>
      &nbsp;<a class="btn" href="/api.md" style="background:#444">Raw Markdown</a>
      &nbsp;<a class="btn" href="https://github.com/trajche/rembro" style="background:#444">GitHub</a>
    </p>
  </div>

  <div class="card">
    <h3>REST API — Session Management</h3>
    <table>
      <tr><td><code>POST /api/sessions</code></td><td>Create a new browser session (accepts JSON body with browser, viewport, locale, etc.)</td></tr>
      <tr><td><code>GET /api/sessions</code></td><td>List all sessions</td></tr>
      <tr><td><code>GET /api/sessions/:id</code></td><td>Get session details</td></tr>
      <tr><td><code>DELETE /api/sessions/:id</code></td><td>Destroy a session</td></tr>
      <tr><td><code>DELETE /api/sessions</code></td><td>Destroy all sessions</td></tr>
      <tr><td><code>GET /api/sessions/:id/logs/stream</code></td><td>SSE live log stream</td></tr>
      <tr><td><code>GET /health</code></td><td>Server health check</td></tr>
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
async function killAllSessions() {
  if (!confirm('Kill ALL sessions?')) return;
  await fetch('/api/sessions', { method: 'DELETE' });
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
