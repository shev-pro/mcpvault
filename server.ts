#!/usr/bin/env node

import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer, stdioMaxBufferSize } from "./src/createServer.js";
import { parseCliArgs } from "./src/cli.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

// Get package.json version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
);
const VERSION = packageJson.version;

// Handle --version and --help flags
const cliArgs = process.argv.slice(2);
const firstArg = cliArgs[0];

if (firstArg === "--version" || firstArg === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (firstArg === "--help" || firstArg === "-h") {
  console.log(`
mcpvault v${VERSION}

Universal AI bridge for Obsidian vaults - connect any MCP-compatible assistant

Usage:
  npx @bitbonsai/mcpvault [vault-path] [--read-only[=true|false]] [--exclude <subtree>]...

Arguments:
  [vault-path]    Optional path to your Obsidian vault directory
                  Defaults to current working directory when omitted

Options:
  --version, -v   Show version number
  --help, -h      Show this help message
  --read-only     Expose read tools only and reject all vault mutations
                  May be passed alone, with true/false, or as --read-only=true
  --exclude PATH  Hide a vault-relative subtree from search and directory listings
                  Repeat for multiple subtrees; direct read/write tools are unaffected
  --max-upload-mb <n>
                  Maximum accepted upload_file size in megabytes (default: 10)
                  May be passed as --max-upload-mb <n> or --max-upload-mb=<n>

Examples:
  npx @bitbonsai/mcpvault
  npx @bitbonsai/mcpvault ~/Documents/MyVault
  npx @bitbonsai/mcpvault ./Vault
  npx @bitbonsai/mcpvault ./Vault --read-only
  npx @bitbonsai/mcpvault ./Vault --exclude Archive --exclude "Snapshots/Old"
  npx @bitbonsai/mcpvault /path/to/obsidian/vault
  npx @bitbonsai/mcpvault "/path/with spaces/Obsidian Vault"
`);
  process.exit(0);
}

// Remove runtime options before joining trailing args, preserving support for
// unquoted vault paths with spaces. When omitted, use the current directory.
const { vaultPathArg, readOnly, excludePaths, maxUploadMb } = parseCliArgs(cliArgs);
const vaultPath = resolve(vaultPathArg || process.cwd());
const maxUploadBytes = maxUploadMb !== undefined ? Math.floor(maxUploadMb * 1024 * 1024) : undefined;

// Serve both the legacy handshake-based protocol and MCP 2026-07-28 from the
// same process. The opening exchange selects the era for this connection.
const serverHandle = serveStdio(
  () => createServer(vaultPath, {
    version: VERSION,
    readOnly,
    excludePaths,
    ...(maxUploadBytes !== undefined ? { maxUploadBytes } : {}),
  }),
  {
    onerror: (error) => console.error(error),
    // Sized from the upload limit: the SDK default (10 MiB) would drop the
    // connection on a base64 upload above ~7.5 MiB.
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: stdioMaxBufferSize(maxUploadBytes),
    }),
  },
);

// Exit when the client disconnects (stdin EOF) or the process is asked to
// terminate. Hosts that don't send an MCP shutdown request otherwise leave
// this process running forever, orphaned once stdin closes (#159).
let isShuttingDown = false;
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    await serverHandle.close();
  } catch {
    // Best-effort: exit regardless of transport close errors.
  }
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
