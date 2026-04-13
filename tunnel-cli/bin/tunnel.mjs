#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Argument parsing (no dependencies) ---

const args = process.argv.slice(2);

function getArg(names, defaultValue) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]) && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return defaultValue;
}

function hasFlag(names) {
  return args.some((a) => names.includes(a));
}

// Show help
if (hasFlag(["--help"]) || args.length === 0) {
  console.log(`
RemoteBrowserMCP Tunnel

Usage:
  remotebrowser-tunnel --port <port> [options]

Options:
  -p, --port         Local port to expose (required)
  -h, --host         Remote host (default: rembro.digitalno.de)
  -r, --remote-port  Port on remote side (default: same as --port)
  -k, --key          Path to SSH private key (default: ./tunnel_key)
      --ssh-port     SSH port on remote (default: 2222)
      --help         Show this help message

Examples:
  remotebrowser-tunnel --port 3000
  remotebrowser-tunnel -p 8080 -r 3000 -k ~/.ssh/tunnel_key
  remotebrowser-tunnel --port 3000 --host rembro.digitalno.de --key ./tunnel_key
`);
  process.exit(0);
}

const localPort = getArg(["-p", "--port"], null);
const host = getArg(["-h", "--host"], "rembro.digitalno.de");
const remotePort = getArg(["-r", "--remote-port"], localPort);
const keyPath = resolve(getArg(["-k", "--key"], "./tunnel_key"));
const sshPort = getArg(["--ssh-port"], "2222");

// --- Validation ---

if (!localPort) {
  console.error("Error: --port is required. Run with --help for usage.");
  process.exit(1);
}

if (!/^\d+$/.test(localPort) || +localPort < 1 || +localPort > 65535) {
  console.error(`Error: Invalid port "${localPort}". Must be 1-65535.`);
  process.exit(1);
}

if (!existsSync(keyPath)) {
  console.error(`Error: SSH key not found at "${keyPath}"`);
  console.error(
    "Get your tunnel key from the deploy output or your dashboard."
  );
  process.exit(1);
}

// --- Banner ---

console.log(`
RemoteBrowserMCP Tunnel
Forwarding remote:${remotePort} → localhost:${localPort}
Press Ctrl+C to stop
`);

// --- Spawn SSH reverse tunnel ---

const sshArgs = [
  "-N", // No remote command — just forward ports
  "-R",
  `0.0.0.0:${remotePort}:localhost:${localPort}`, // Bind on all interfaces so Docker containers can reach it
  "-p",
  sshPort,
  "-i",
  keyPath,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ServerAliveInterval=30", // Keep-alive every 30s
  "-o",
  "ServerAliveCountMax=3", // Disconnect after 3 missed keep-alives
  "-o",
  "ExitOnForwardFailure=yes", // Fail fast if the port forward can't bind
  `tunnel@${host}`,
];

const ssh = spawn("ssh", sshArgs, { stdio: "inherit" });

// --- Process event handlers ---

ssh.on("close", (code) => {
  console.log(`Tunnel closed (exit code ${code}).`);
  process.exit(code ?? 0);
});

ssh.on("error", (err) => {
  console.error(`SSH error: ${err.message}`);
  process.exit(1);
});

// --- Graceful shutdown on Ctrl+C / kill ---

function shutdown() {
  console.log("\nTunnel stopped.");
  ssh.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
