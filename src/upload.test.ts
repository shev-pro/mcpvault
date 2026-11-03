import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { vi } from "vitest";
import { FileSystemService, DEFAULT_MAX_UPLOAD_BYTES } from "./filesystem.js";
import type { UploadResult } from "./types.js";
import {
  writeFile,
  readFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  access,
  stat,
} from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/**
 * uploadFile is new, not-yet-implemented surface (design brief:
 * .aicc/design/vault-upload.md). These tests are RED against current
 * filesystem.ts, which has no uploadFile method and does not export
 * DEFAULT_MAX_UPLOAD_BYTES.
 */

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function bytesOf(length: number, fill = 65): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/**
 * Guard refusals may surface as `{ success: false }` (like moveFile) or as a
 * rejected promise (resolvePath throwing on traversal / symlink escape).
 * The contract explicitly accepts either.
 */
async function expectRefused(promise: Promise<UploadResult>): Promise<void> {
  try {
    const result = await promise;
    expect(result.success).toBe(false);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}

let testVaultPath: string;
let outsideDir: string;
let fileSystem: FileSystemService;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-upload-test-"));
  outsideDir = await mkdtemp(join(tmpdir(), "mcpvault-upload-outside-"));
  // 4096 bytes is well above every payload used in these tests (except the
  // dedicated small-limit tests below) while staying fast.
  fileSystem = new FileSystemService(testVaultPath, undefined, undefined, {
    maxUploadBytes: 4096,
  });
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // ignore
  }
  try {
    await rm(outsideDir, { recursive: true });
  } catch {
    // ignore
  }
});

describe("constants", () => {
  test("DEFAULT_MAX_UPLOAD_BYTES is 10 MiB", () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(10485760);
  });
});

describe("attachment folder resolution (I9)", () => {
  test("bare file name goes to vault root when no app.json exists", async () => {
    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
    expect(result.embed).toBe("![[pic.png]]");
    expect(result.size).toBe(4);
    expect(await readFile(join(testVaultPath, "pic.png"))).toEqual(
      Buffer.from(bytesOf(4)),
    );
  });

  test("bare file name goes to the configured attachment folder", async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: "Attachments" }),
    );

    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("Attachments/pic.png");
    expect(result.embed).toBe("![[Attachments/pic.png]]");
    expect(await readFile(join(testVaultPath, "Attachments/pic.png"))).toEqual(
      Buffer.from(bytesOf(4)),
    );
  });

  test('app.json attachmentFolderPath "/" resolves to vault root', async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: "/" }),
    );

    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
  });

  test("missing/unreadable/invalid app.json falls back to vault root", async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(join(testVaultPath, ".obsidian/app.json"), "{ not json");

    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
  });

  test('app.json attachmentFolderPath "./" (note-relative) falls back to vault root', async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: "./" }),
    );

    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
  });

  test('app.json attachmentFolderPath "./assets" (note-relative) falls back to vault root', async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: "./assets" }),
    );

    const result = await fileSystem.uploadFile({
      path: "pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
  });

  test("app.json attachmentFolderPath pointing at a restricted path is refused, nothing written", async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: ".git" }),
    );

    await expectRefused(
      fileSystem.uploadFile({ path: "pic.png", contentBase64: b64(bytesOf(4)) }),
    );
    await expect(access(join(testVaultPath, ".git/pic.png"))).rejects.toThrow();
    await expect(access(join(testVaultPath, "pic.png"))).rejects.toThrow();
  });

  test("leading slash means vault root explicitly, bypassing a configured attachment folder", async () => {
    await mkdir(join(testVaultPath, ".obsidian"), { recursive: true });
    await writeFile(
      join(testVaultPath, ".obsidian/app.json"),
      JSON.stringify({ attachmentFolderPath: "Attachments" }),
    );

    const result = await fileSystem.uploadFile({
      path: "/pic.png",
      contentBase64: b64(bytesOf(4)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("pic.png");
    expect(await readFile(join(testVaultPath, "pic.png"))).toEqual(
      Buffer.from(bytesOf(4)),
    );
  });

  test("an explicit relative path with a folder creates missing parent directories", async () => {
    const result = await fileSystem.uploadFile({
      path: "nested/folder/structure/file.bin",
      contentBase64: b64(bytesOf(6)),
    });
    expect(result.success).toBe(true);
    expect(result.path).toBe("nested/folder/structure/file.bin");
    expect(
      await readFile(join(testVaultPath, "nested/folder/structure/file.bin")),
    ).toEqual(Buffer.from(bytesOf(6)));
  });
});

describe("security guards (I1)", () => {
  test.each([".obsidian/x.png", ".git/x.bin", "a/.hidden.png"])(
    "refuses restricted path %s and writes nothing",
    async (path) => {
      await expectRefused(
        fileSystem.uploadFile({ path, contentBase64: b64(bytesOf(2)) }),
      );
      await expect(access(join(testVaultPath, path))).rejects.toThrow();
    },
  );

  test("refuses path traversal", async () => {
    await expectRefused(
      fileSystem.uploadFile({
        path: "../x.png",
        contentBase64: b64(bytesOf(2)),
      }),
    );
  });

  test("refuses writing over an existing directory", async () => {
    await mkdir(join(testVaultPath, "blockeddir"));
    await expectRefused(
      fileSystem.uploadFile({
        path: "/blockeddir",
        contentBase64: b64(bytesOf(2)),
      }),
    );
    expect((await stat(join(testVaultPath, "blockeddir"))).isDirectory()).toBe(
      true,
    );
  });

  test("refuses a target whose parent is a symlink pointing outside the vault", async () => {
    await symlink(outsideDir, join(testVaultPath, "shortcut"));
    await expectRefused(
      fileSystem.uploadFile({
        path: "shortcut/evil.png",
        contentBase64: b64(bytesOf(2)),
      }),
    );
    await expect(access(join(outsideDir, "evil.png"))).rejects.toThrow();
  });

  test.each(["pic.png", "doc.pdf", "prog.exe", "script.sh", "README"])(
    "accepts any extension, including none: %s",
    async (name) => {
      const bytes = bytesOf(5, 7);
      const result = await fileSystem.uploadFile({
        path: name,
        contentBase64: b64(bytes),
      });
      expect(result.success).toBe(true);
      expect(await readFile(join(testVaultPath, name))).toEqual(
        Buffer.from(bytes),
      );
    },
  );
});

describe("exactly one content source (I6)", () => {
  test("refuses when neither contentBase64 nor file is provided", async () => {
    await expectRefused(fileSystem.uploadFile({ path: "x.png" }));
    await expect(access(join(testVaultPath, "x.png"))).rejects.toThrow();
  });

  test("refuses when both contentBase64 and file are provided", async () => {
    await expectRefused(
      fileSystem.uploadFile({
        path: "x.png",
        contentBase64: b64(bytesOf(2)),
        file: { download_url: "https://example.com/a", file_id: "f1" },
      }),
    );
    await expect(access(join(testVaultPath, "x.png"))).rejects.toThrow();
  });

  test.each(["@@@", "abcde"])(
    "refuses invalid base64 payload: %s",
    async (invalid) => {
      await expectRefused(
        fileSystem.uploadFile({ path: "bad.png", contentBase64: invalid }),
      );
      await expect(access(join(testVaultPath, "bad.png"))).rejects.toThrow();
    },
  );

  test("empty content (0 bytes) is allowed", async () => {
    const result = await fileSystem.uploadFile({
      path: "empty.bin",
      contentBase64: "",
    });
    expect(result.success).toBe(true);
    expect(result.size).toBe(0);
    const written = await readFile(join(testVaultPath, "empty.bin"));
    expect(written.length).toBe(0);
  });
});

describe("size limit (I5)", () => {
  test("accepts content exactly at the configured limit", async () => {
    const limited = new FileSystemService(testVaultPath, undefined, undefined, {
      maxUploadBytes: 16,
    });
    const bytes = bytesOf(16);
    const result = await limited.uploadFile({
      path: "atlimit.bin",
      contentBase64: b64(bytes),
    });
    expect(result.success).toBe(true);
    expect(result.size).toBe(16);
    expect(await readFile(join(testVaultPath, "atlimit.bin"))).toEqual(
      Buffer.from(bytes),
    );
  });

  test("refuses content one byte over the limit, nothing written", async () => {
    const limited = new FileSystemService(testVaultPath, undefined, undefined, {
      maxUploadBytes: 16,
    });
    const bytes = bytesOf(17, 66);
    await expectRefused(
      limited.uploadFile({ path: "overlimit.bin", contentBase64: b64(bytes) }),
    );
    await expect(
      access(join(testVaultPath, "overlimit.bin")),
    ).rejects.toThrow();
  });

  test("refusal message does not leak the uploaded content", async () => {
    const limited = new FileSystemService(testVaultPath, undefined, undefined, {
      maxUploadBytes: 16,
    });
    const secret = new TextEncoder().encode("TOPSECRETMARKERVALUE");
    const encoded = b64(secret);
    // Canary: without this, a TypeError thrown because uploadFile does not
    // exist yet would be swallowed by the catch below and vacuously satisfy
    // the "does not contain the secret" assertions without exercising the
    // real refusal path at all.
    expect(typeof limited.uploadFile).toBe("function");
    let message = "";
    try {
      const result = await limited.uploadFile({
        path: "secret.bin",
        contentBase64: encoded,
      });
      expect(result.success).toBe(false);
      message = result.message ?? "";
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).not.toContain(encoded);
    expect(message).not.toContain("TOPSECRETMARKERVALUE");
  });
});

describe("overwrite semantics (I2, I3)", () => {
  test("refuses an existing target without overwrite, original untouched", async () => {
    await fileSystem.uploadFile({ path: "existing.bin", contentBase64: b64(bytesOf(3, 1)) });
    await expectRefused(
      fileSystem.uploadFile({
        path: "existing.bin",
        contentBase64: b64(bytesOf(3, 2)),
      }),
    );
    expect(await readFile(join(testVaultPath, "existing.bin"))).toEqual(
      Buffer.from(bytesOf(3, 1)),
    );
  });

  test("refuses overwrite:true without confirmPath, original untouched", async () => {
    await fileSystem.uploadFile({ path: "existing2.bin", contentBase64: b64(bytesOf(3, 1)) });
    await expectRefused(
      fileSystem.uploadFile({
        path: "existing2.bin",
        contentBase64: b64(bytesOf(3, 2)),
        overwrite: true,
      }),
    );
    expect(await readFile(join(testVaultPath, "existing2.bin"))).toEqual(
      Buffer.from(bytesOf(3, 1)),
    );
  });

  test("refuses overwrite:true with a mismatching confirmPath, original untouched", async () => {
    await fileSystem.uploadFile({ path: "existing3.bin", contentBase64: b64(bytesOf(3, 1)) });
    await expectRefused(
      fileSystem.uploadFile({
        path: "existing3.bin",
        contentBase64: b64(bytesOf(3, 2)),
        overwrite: true,
        confirmPath: "not-existing3.bin",
      }),
    );
    expect(await readFile(join(testVaultPath, "existing3.bin"))).toEqual(
      Buffer.from(bytesOf(3, 1)),
    );
  });

  test("overwrite:true with matching confirmPath replaces the file", async () => {
    await fileSystem.uploadFile({ path: "existing4.bin", contentBase64: b64(bytesOf(3, 1)) });
    const result = await fileSystem.uploadFile({
      path: "existing4.bin",
      contentBase64: b64(bytesOf(3, 2)),
      overwrite: true,
      confirmPath: "existing4.bin",
    });
    expect(result.success).toBe(true);
    expect(result.overwritten).toBe(true);
    expect(await readFile(join(testVaultPath, "existing4.bin"))).toEqual(
      Buffer.from(bytesOf(3, 2)),
    );
  });
});

describe("bytes are written verbatim (I4)", () => {
  test("a full 0..255 byte range round-trips exactly", async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const result = await fileSystem.uploadFile({
      path: "binary.dat",
      contentBase64: b64(bytes),
    });
    expect(result.success).toBe(true);
    expect(result.size).toBe(256);

    const written = await readFile(join(testVaultPath, "binary.dat"));
    expect(Buffer.compare(written, Buffer.from(bytes))).toBe(0);
  });
});

describe("file/download source", () => {
  test("downloads via the injected download function and writes the returned bytes", async () => {
    const returned = new Uint8Array([10, 20, 30, 40]);
    const download = vi.fn(async (_url: string, _opts: { maxBytes: number }) =>
      returned,
    );
    const withDownload = new FileSystemService(
      testVaultPath,
      undefined,
      undefined,
      { maxUploadBytes: 4096, download },
    );

    const result = await withDownload.uploadFile({
      path: "downloaded.png",
      file: {
        download_url: "https://example.com/x?token=secret123",
        file_id: "abc",
      },
    });

    expect(result.success).toBe(true);
    expect(download).toHaveBeenCalledWith(
      "https://example.com/x?token=secret123",
      { maxBytes: 4096 },
    );
    expect(await readFile(join(testVaultPath, "downloaded.png"))).toEqual(
      Buffer.from(returned),
    );
  });

  test("a rejecting download refuses the upload, writes nothing, and never echoes the url", async () => {
    const downloadUrl = "https://example.com/secret-path?token=xyz987";
    const download = vi.fn(async () => {
      throw new Error("Download refused: host resolves to a private address");
    });
    const withDownload = new FileSystemService(
      testVaultPath,
      undefined,
      undefined,
      { maxUploadBytes: 4096, download },
    );

    // Canary: see comment on the equivalent assertion in the size-limit
    // message-safety test above.
    expect(typeof withDownload.uploadFile).toBe("function");
    let message = "";
    try {
      const result = await withDownload.uploadFile({
        path: "failed.png",
        file: { download_url: downloadUrl, file_id: "f2" },
      });
      expect(result.success).toBe(false);
      message = result.message ?? "";
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).not.toContain(downloadUrl);
    expect(download).toHaveBeenCalled();
    await expect(access(join(testVaultPath, "failed.png"))).rejects.toThrow();
  });
});
