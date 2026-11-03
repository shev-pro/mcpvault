import { test, expect, describe, vi } from "vitest";
import { downloadToBuffer, isBlockedAddress } from "./download.js";

/**
 * download.ts is new, not-yet-implemented surface (design brief:
 * .aicc/design/vault-upload.md, invariant I7). These tests are RED: the
 * module does not exist on current code.
 *
 * Every test injects fetchImpl and lookup so none of this ever touches the
 * real network or real DNS.
 */

type LookupResult = Array<{ address: string; family: number }>;

function lookupOf(result: LookupResult) {
  return vi.fn(async (_hostname: string) => result);
}

describe("isBlockedAddress", () => {
  test.each([
    ["loopback v4", "127.0.0.1"],
    ["loopback v4 upper", "127.255.255.255"],
    ["loopback v6", "::1"],
    ["private 10/8", "10.0.0.1"],
    ["private 172.16/12 lower", "172.16.0.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local v4", "169.254.1.1"],
    ["link-local v6", "fe80::1"],
    ["CGNAT 100.64/10 lower", "100.64.0.1"],
    ["unspecified v4", "0.0.0.0"],
    ["unspecified v6", "::"],
    ["multicast v4", "224.0.0.1"],
    ["multicast v6", "ff00::1"],
    ["broadcast", "255.255.255.255"],
    ["ULA", "fc00::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
  ])("blocks %s (%s)", (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each([
    ["public v4", "8.8.8.8"],
    ["public v6", "2606:4700::1111"],
    ["just outside 172.16/12", "172.32.0.1"],
    ["just outside CGNAT range", "100.128.0.1"],
  ])("allows %s (%s)", (_label, ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("downloadToBuffer", () => {
  test("refuses non-https schemes", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    for (const url of ["http://example.com/a", "file:///etc/passwd", "ftp://example.com/a"]) {
      await expect(
        downloadToBuffer(url, { maxBytes: 100, fetchImpl, lookup }),
      ).rejects.toThrow(/^Download refused/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses an IP-literal loopback/private host without needing DNS", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupOf([{ address: "8.8.8.8", family: 4 }]);
    await expect(
      downloadToBuffer("https://127.0.0.1/x?token=ABC", {
        maxBytes: 100,
        fetchImpl,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses a hostname that resolves to a private address, never leaking the full url", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupOf([{ address: "10.0.0.5", family: 4 }]);
    const url = "https://internal.example/path?token=SECRET";

    let message = "";
    try {
      await downloadToBuffer(url, { maxBytes: 100, fetchImpl, lookup });
      throw new Error("expected downloadToBuffer to reject");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/^Download refused/);
    expect(message).not.toContain(url);
    expect(message).not.toContain("token=SECRET");
    expect(lookup).toHaveBeenCalledWith("internal.example");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("refuses when ANY resolved address is blocked, even if another is public", async () => {
    const fetchImpl = vi.fn();
    const lookup = lookupOf([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ]);
    await expect(
      downloadToBuffer("https://mixed.example/x", { maxBytes: 100, fetchImpl, lookup }),
    ).rejects.toThrow(/^Download refused/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("calls fetch with redirect: manual", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async (_input: string | URL, _init?: RequestInit) => {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    await downloadToBuffer("https://public.example/x", {
      maxBytes: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe("manual");
  });

  test("follows a redirect to a public host and returns the final bytes", async () => {
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "redirect-source.example") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "redirect-target.example") return [{ address: "93.184.216.35", family: 4 }];
      throw new Error(`unexpected lookup: ${hostname}`);
    });
    const finalBytes = new Uint8Array([9, 8, 7]);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://redirect-source.example/a") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://redirect-target.example/b" },
        });
      }
      if (url === "https://redirect-target.example/b") {
        return new Response(finalBytes, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await downloadToBuffer("https://redirect-source.example/a", {
      maxBytes: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(Buffer.compare(Buffer.from(result), Buffer.from(finalBytes))).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("refuses a redirect whose target resolves to a private address", async () => {
    const lookup = vi.fn(async (hostname: string) => {
      if (hostname === "redirect-source2.example") return [{ address: "93.184.216.34", family: 4 }];
      if (hostname === "internal.example") return [{ address: "10.0.0.5", family: 4 }];
      throw new Error(`unexpected lookup: ${hostname}`);
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://redirect-source2.example/a") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.example/private" },
        });
      }
      throw new Error(`unexpected second fetch: ${url}`);
    });

    await expect(
      downloadToBuffer("https://redirect-source2.example/a", {
        maxBytes: 100,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);

    // The redirect target must be validated BEFORE it is ever fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("refuses after more than 5 redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      const match = /\/hop(\d+)$/.exec(url);
      const hop = match ? Number(match[1]) : 0;
      return new Response(null, {
        status: 302,
        headers: { location: `https://redirect-chain.example/hop${hop + 1}` },
      });
    });

    await expect(
      downloadToBuffer("https://redirect-chain.example/hop0", {
        maxBytes: 100,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);

    // 1 initial request + at most 5 redirects followed = 6 fetch calls max;
    // the (otherwise) 7th hop must be refused without an extra fetch.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  test("refuses a non-2xx final response", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      downloadToBuffer("https://public.example/missing", {
        maxBytes: 100,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);
  });

  test("refuses when Content-Length exceeds maxBytes, before reading the body", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(5), {
        status: 200,
        headers: { "content-length": "1000" },
      }),
    );

    await expect(
      downloadToBuffer("https://public.example/big", {
        maxBytes: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);
  });

  test("refuses a streamed body exceeding maxBytes with no Content-Length", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20).fill(1));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));

    await expect(
      downloadToBuffer("https://public.example/stream", {
        maxBytes: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);
  });

  test("times out when fetch never settles, without touching the network", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const fetchImpl = vi.fn((_input: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    await expect(
      downloadToBuffer("https://public.example/slow", {
        maxBytes: 100,
        timeoutMs: 50,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        lookup,
      }),
    ).rejects.toThrow(/^Download refused/);
  }, 1000);

  test("returns the exact bytes for a successful public download", async () => {
    const lookup = lookupOf([{ address: "93.184.216.34", family: 4 }]);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchImpl = vi.fn(async () => new Response(payload, { status: 200 }));

    const result = await downloadToBuffer("https://public.example/ok", {
      maxBytes: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup,
    });

    expect(Buffer.compare(Buffer.from(result), Buffer.from(payload))).toBe(0);
  });
});
