import { test, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "./createServer.js";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

/**
 * upload_file is a new MCP tool (design brief: .aicc/design/vault-upload.md).
 * createServer does not register it yet, so every test here is RED against
 * current code (tools/list won't contain "upload_file" and tools/call will
 * hit the "Unknown tool" default branch).
 */

let testVaultPath: string;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-upload-server-"));
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // ignore
  }
});

async function connectClient(options: Parameters<typeof createServer>[1] = {}) {
  const server = createServer(testVaultPath, { version: "1.0.0", ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "upload-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { server, client };
}

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

test("tools/list includes upload_file with the expected schema and _meta", async () => {
  const { server, client } = await connectClient();
  try {
    const result = await client.listTools();
    const uploadTool = result.tools.find((t) => t.name === "upload_file") as
      | (typeof result.tools)[number] & { _meta?: Record<string, unknown> }
      | undefined;

    expect(uploadTool).toBeDefined();
    const schema = uploadTool!.inputSchema as any;
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["path", "contentBase64", "file", "overwrite", "confirmPath"]),
    );
    expect(schema.required).toEqual(["path"]);
    expect((uploadTool as any)._meta).toEqual({
      "openai/fileParams": ["file"],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("upload_file writes a file end-to-end via base64 content", async () => {
  const { server, client } = await connectClient();
  try {
    const bytes = [1, 2, 3, 4, 5];
    const result = await client.callTool({
      name: "upload_file",
      arguments: { path: "pic.png", contentBase64: b64(bytes) },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.path).toBe("pic.png");
    expect(parsed.embed).toBe("![[pic.png]]");

    const written = await readFile(join(testVaultPath, "pic.png"));
    expect(Buffer.compare(written, Buffer.from(bytes))).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("upload_file tools/call returns isError:true and success:false together on refusal", async () => {
  const { server, client } = await connectClient();
  try {
    const result = await client.callTool({
      name: "upload_file",
      arguments: { path: "neither-source.png" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.success).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("createServer maxUploadBytes option is enforced by the upload_file tool", async () => {
  const { server, client } = await connectClient({ maxUploadBytes: 4 });
  try {
    const okResult = await client.callTool({
      name: "upload_file",
      arguments: { path: "ok.bin", contentBase64: b64([1, 2, 3, 4]) },
    });
    expect(okResult.isError).toBeFalsy();

    const tooBig = await client.callTool({
      name: "upload_file",
      arguments: { path: "toobig.bin", contentBase64: b64([1, 2, 3, 4, 5]) },
    });
    expect(tooBig.isError).toBe(true);
    const parsed = JSON.parse((tooBig.content as any)[0].text);
    expect(parsed.success).toBe(false);
    await expect(readFile(join(testVaultPath, "toobig.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("read-only mode hides upload_file from tools/list and rejects tools/call", async () => {
  const { server, client } = await connectClient({ readOnly: true });
  try {
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("upload_file");

    const result = await client.callTool({
      name: "upload_file",
      arguments: { path: "blocked.png", contentBase64: b64([1, 2, 3]) },
    });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("read-only mode");

    await expect(readFile(join(testVaultPath, "blocked.png"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
