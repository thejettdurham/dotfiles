#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKMODE_DIR = __dirname;
const HOSTS_PATH = "/etc/hosts";
const HOSTS_MARKER_START = "# workmode-block-start";
const HOSTS_MARKER_END = "# workmode-block-end";

let hostsBackup: string | null = null;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let httpsServer: ReturnType<typeof createHttpsServer> | null = null;
let restored = false;

function restoreHosts(): void {
  if (restored || !hostsBackup) return;
  restored = true;
  try {
    writeFileSync(HOSTS_PATH, hostsBackup!, { mode: 0o644 });
    console.log("Hosts file restored.");
  } catch (err) {
    console.error("Failed to restore hosts file:", err);
    console.error("Run with sudo to fix: sudo npm run workmode");
    process.exit(1);
  }
}

function shutdown(): void {
  restoreHosts();
  httpServer?.close();
  httpsServer?.close();
  process.exit(0);
}

function parseBlockFile(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf-8");
  const list = JSON.parse(raw) as string[];
  if (!Array.isArray(list) || list.some((d) => typeof d !== "string")) {
    throw new Error(`${filePath} must be an array of domain strings`);
  }
  return list;
}

function loadBlocklist(): { domains: string[]; sourceFiles: string[] } {
  const domains = new Set<string>();
  const sourceFiles: string[] = [];

  const basePath = join(WORKMODE_DIR, "workmode-block.json");
  for (const d of parseBlockFile(basePath)) domains.add(d);
  sourceFiles.push("workmode-block.json");

  const blockDir = join(WORKMODE_DIR, "block.d");
  if (existsSync(blockDir)) {
    const files = readdirSync(blockDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort();
    for (const f of files) {
      for (const d of parseBlockFile(join(blockDir, f))) domains.add(d);
      sourceFiles.push(`block.d/${f}`);
    }
  }

  return { domains: [...domains], sourceFiles };
}

function loadBlockPage(): string {
  const path = join(WORKMODE_DIR, "block.html");
  return readFileSync(path, "utf-8");
}

function ensureMkcertCert(domains: string[]): { cert: string; key: string } {
  const certPath = join(WORKMODE_DIR, "cert.pem");
  const keyPath = join(WORKMODE_DIR, "key.pem");
  const san = ["localhost", "127.0.0.1", ...domains];
  execSync(`mkcert -cert-file "${certPath}" -key-file "${keyPath}" ${san.join(" ")}`, {
    env: { ...process.env, CAROOT: WORKMODE_DIR },
    stdio: "pipe",
  });
  return {
    cert: readFileSync(certPath, "utf-8"),
    key: readFileSync(keyPath, "utf-8"),
  };
}

function applyHostsBlock(domains: string[], sourceFiles: string[]): void {
  const current = readFileSync(HOSTS_PATH, "utf-8");
  hostsBackup = current;

  const block = [
    "",
    HOSTS_MARKER_START,
    ...domains.map((d) => `127.0.0.1 ${d}`),
    HOSTS_MARKER_END,
  ].join("\n");

  const withoutBlock = current
    .replace(new RegExp(`\n?${HOSTS_MARKER_START}[\\s\\S]*?${HOSTS_MARKER_END}\n?`, "g"), "")
    .trimEnd();

  try {
    writeFileSync(HOSTS_PATH, withoutBlock + block + "\n", { mode: 0o644 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      console.error("Permission denied. Run with sudo: sudo npm run workmode");
    }
    throw err;
  }
  console.log("Hosts file updated. Block lists:", sourceFiles.join(", "));
}

function restartChrome(): void {
  try {
    execSync(`osascript -e 'quit app "Google Chrome"'`, { stdio: "pipe" });
    execSync("sleep 2", { stdio: "pipe" });
    execSync('open -a "Google Chrome"', { stdio: "pipe" });
    console.log("Chrome restarted (DNS cache cleared).");
  } catch (err) {
    console.warn("Could not restart Chrome:", (err as Error).message);
  }
}

function main(): void {
  const restartChromeFlag = process.argv.includes("--restart-chrome");
  const { domains: blocklist, sourceFiles } = loadBlocklist();
  const blockPage = loadBlockPage();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("uncaughtException", (err) => {
    console.error(err);
    restoreHosts();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    restoreHosts();
    process.exit(1);
  });

  applyHostsBlock(blocklist, sourceFiles);

  if (restartChromeFlag) restartChrome();

  const handler = (
    _req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(blockPage);
  };

  httpServer = createHttpServer(handler);
  httpServer.on("error", (err) => {
    console.error("HTTP server error:", err);
    restoreHosts();
    process.exit(1);
  });
  httpServer.listen(80, "127.0.0.1", () => {
    console.log("HTTP server listening on 127.0.0.1:80");
  });

  const { cert, key } = ensureMkcertCert(blocklist);
  httpsServer = createHttpsServer({ cert, key }, handler);
  httpsServer.on("error", (err) => {
    console.error("HTTPS server error:", err);
    restoreHosts();
    process.exit(1);
  });
  httpsServer.listen(443, "127.0.0.1", () => {
    console.log("HTTPS server listening on 127.0.0.1:443");
  });

  console.log("\nWorkmode active. Press Ctrl+C to stop.");
  console.log("Usage: npm run workmode [-- --restart-chrome]\n");
  console.log("If HTTPS shows certificate warnings, run:");
  console.log(`  CAROOT="${WORKMODE_DIR}" mkcert -install\n`);
}

main();
