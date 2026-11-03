import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { stdioMaxBufferSize } from "./createServer.js";
import { DEFAULT_MAX_UPLOAD_BYTES } from "./filesystem.js";

// Third review (PR #1): the SDK's stdio transport refuses any JSON-RPC message
// over 10 MiB, so a base64 upload near the 10 MiB file limit (~13.4 MB on the
// wire) dropped the connection. These tests go through the real entry point
// (dist/server.js) over real stdio, which the in-memory tests cannot see.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const builtServer = join(repoRoot, "dist", "server.js");
const vaults: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(vaults.splice(0).map((v) => rm(v, { recursive: true, force: true })));
});

async function connect(extraArgs: string[] = []) {
  const vault = await mkdtemp(join(tmpdir(), "mcpvault-stdio-upload-"));
  vaults.push(vault);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtServer, ...extraArgs, vault],
    cwd: repoRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "mcpvault-stdio-upload-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, vault };
}

async function uploadOverStdio(client: Client, bytes: number) {
  const contentBase64 = Buffer.alloc(bytes, 7).toString("base64");
  return client.callTool({ name: "upload_file", arguments: { path: "big.bin", contentBase64 } });
}

test("stdioMaxBufferSize fits a base64 upload at the limit plus JSON overhead", () => {
  for (const limit of [1024, DEFAULT_MAX_UPLOAD_BYTES, 50 * 1024 * 1024]) {
    const encoded = Math.ceil(limit / 3) * 4;
    expect(stdioMaxBufferSize(limit)).toBeGreaterThan(encoded + 64 * 1024);
  }
  // Never below the SDK's own default.
  expect(stdioMaxBufferSize(1)).toBeGreaterThanOrEqual(10 * 1024 * 1024);
});

test("a base64 upload just under the default limit succeeds over real stdio", async () => {
  const { client, vault } = await connect();
  const size = DEFAULT_MAX_UPLOAD_BYTES - 1024;
  const result = await uploadOverStdio(client, size);
  expect(result.isError).toBeFalsy();
  expect((await stat(join(vault, "big.bin"))).size).toBe(size);
}, 30000);

test("--max-upload-mb raises the stdio buffer with the limit", async () => {
  const { client, vault } = await connect(["--max-upload-mb", "16"]);
  const size = 15 * 1024 * 1024;
  const result = await uploadOverStdio(client, size);
  expect(result.isError).toBeFalsy();
  expect((await stat(join(vault, "big.bin"))).size).toBe(size);
}, 30000);
