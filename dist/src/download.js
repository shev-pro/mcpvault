import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/**
 * True when `ip` (a literal address, not a hostname) must never be reached by
 * an outbound download: loopback, RFC1918 private ranges, link-local, CGNAT
 * (100.64/10), unspecified, multicast, broadcast, IPv6 ULA (fc00::/7), and
 * the IPv4-mapped IPv6 form of any blocked IPv4 address. Hostnames (not IP
 * literals) always return false here — they are resolved and the resulting
 * addresses are checked individually by the caller.
 */
export function isBlockedAddress(ip) {
    if (isIPv4(ip))
        return isBlockedIPv4(ip);
    if (isIPv6(ip))
        return isBlockedIPv6(ip);
    return false;
}
function ipv4ToInt(ip) {
    let value = 0;
    for (const part of ip.split(".")) {
        value = (value << 8) | (Number(part) & 0xff);
    }
    return value >>> 0;
}
function ipv4InRange(value, base, prefixBits) {
    const baseValue = ipv4ToInt(base);
    const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
    return (value & mask) === (baseValue & mask);
}
function isBlockedIPv4(ip) {
    if (ip === "0.0.0.0" || ip === "255.255.255.255")
        return true;
    const value = ipv4ToInt(ip);
    return (ipv4InRange(value, "127.0.0.0", 8) || // loopback
        ipv4InRange(value, "10.0.0.0", 8) || // private
        ipv4InRange(value, "172.16.0.0", 12) || // private
        ipv4InRange(value, "192.168.0.0", 16) || // private
        ipv4InRange(value, "169.254.0.0", 16) || // link-local
        ipv4InRange(value, "100.64.0.0", 10) || // CGNAT
        ipv4InRange(value, "224.0.0.0", 4) // multicast
    );
}
/**
 * Expand an IPv6 literal (including the dotted-quad tail of an IPv4-mapped
 * address like `::ffff:127.0.0.1`) into its 128-bit integer value.
 */
function ipv6ToBigInt(ip) {
    let address = ip;
    const ipv4TailMatch = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
    if (ipv4TailMatch) {
        const ipv4 = ipv4TailMatch[1];
        const octets = ipv4.split(".").map((part) => Number(part));
        const group1 = ((octets[0] << 8) | octets[1]).toString(16);
        const group2 = ((octets[2] << 8) | octets[3]).toString(16);
        address = `${address.slice(0, address.length - ipv4.length)}${group1}:${group2}`;
    }
    const sides = address.split("::");
    const head = sides[0] ? sides[0].split(":").filter(Boolean) : [];
    const tail = sides.length > 1 && sides[1] ? sides[1].split(":").filter(Boolean) : [];
    const missing = Math.max(8 - head.length - tail.length, 0);
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    let result = 0n;
    for (const group of groups) {
        result = (result << 16n) | BigInt(parseInt(group || "0", 16));
    }
    return result;
}
function v6InRange(value, base, prefixBits) {
    const shift = BigInt(128 - prefixBits);
    return value >> shift === base >> shift;
}
function isBlockedIPv6(ip) {
    const value = ipv6ToBigInt(ip);
    if (value === 0n)
        return true; // unspecified ::
    if (value === 1n)
        return true; // loopback ::1
    // IPv4-mapped (::ffff:a.b.c.d): top 80 bits zero, next 16 bits 0xffff.
    if (value >> 32n === 0xffffn) {
        const ipv4 = [
            Number((value >> 24n) & 0xffn),
            Number((value >> 16n) & 0xffn),
            Number((value >> 8n) & 0xffn),
            Number(value & 0xffn),
        ].join(".");
        return isBlockedIPv4(ipv4);
    }
    return (v6InRange(value, ipv6ToBigInt("fe80::"), 10) || // link-local
        v6InRange(value, ipv6ToBigInt("ff00::"), 8) || // multicast
        v6InRange(value, ipv6ToBigInt("fc00::"), 7) // unique local (ULA)
    );
}
async function defaultLookup(hostname) {
    return dnsLookup(hostname, { all: true });
}
/**
 * Validate a URL's host against the blocklist before it is ever handed to
 * fetch. IP literals are checked directly; hostnames are resolved (all
 * addresses) and every resolved address is checked — a hostname with any
 * blocked address among several is refused.
 */
/**
 * Settle with `promise`, or reject as soon as `signal` aborts — so the
 * download's single deadline also bounds work (DNS) that takes no signal.
 */
function withDeadline(promise, signal) {
    if (signal.aborted)
        return Promise.reject(new Error("aborted"));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); }, (error) => { signal.removeEventListener("abort", onAbort); reject(error); });
    });
}
async function validateHost(rawHostname, lookup, signal) {
    // URL.hostname keeps the brackets of an IPv6 literal ("[::1]").
    const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
        ? rawHostname.slice(1, -1)
        : rawHostname;
    if (isIPv4(hostname) || isIPv6(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw new Error(`Download refused: host ${hostname} resolves to a restricted address`);
        }
        return;
    }
    let addresses;
    try {
        addresses = await withDeadline(lookup(hostname), signal);
    }
    catch {
        // The resolver's own message is dropped: it is not needed and the rule is
        // that nothing about the request leaks into errors.
        if (signal.aborted)
            throw new Error("Download refused: timed out");
        throw new Error(`Download refused: host ${hostname} could not be resolved`);
    }
    for (const { address } of addresses) {
        if (isBlockedAddress(address)) {
            throw new Error(`Download refused: host ${hostname} resolves to a restricted address`);
        }
    }
}
/**
 * Read a fetch Response body, refusing as soon as it is known to exceed
 * maxBytes — from Content-Length when present (before reading anything), or
 * from a running count while streaming otherwise. Never buffers more than
 * maxBytes + the size of the single chunk that tipped it over.
 */
async function readBodyCapped(response, maxBytes) {
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error("Download refused: content exceeds the configured size limit");
        }
    }
    const body = response.body;
    if (!body) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
            throw new Error("Download refused: content exceeds the configured size limit");
        }
        return buffer;
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                try {
                    await reader.cancel();
                }
                catch {
                    // best effort
                }
                throw new Error("Download refused: content exceeds the configured size limit");
            }
            chunks.push(value);
        }
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
/**
 * Download `url` into memory under the rules in design brief invariant I7:
 * https only, loopback/private/link-local/CGNAT/unspecified/multicast/
 * broadcast/ULA/IPv4-mapped addresses blocked (by IP literal or by resolving
 * every address a hostname has), manual redirects re-validated the same way
 * up to 5 hops, non-2xx refused, size capped by Content-Length and by a
 * streamed running count, and an overall timeout (default 30s).
 *
 * Every error message starts with "Download refused" and never contains the
 * requested URL (which may carry a signed token in its query string) — only
 * the bare host, when naming one is useful.
 */
export async function downloadToBuffer(url, options) {
    const { maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const lookup = options.lookup ?? defaultLookup;
    const signal = AbortSignal.timeout(timeoutMs);
    let currentUrl = url;
    let redirectCount = 0;
    for (;;) {
        let parsed;
        try {
            parsed = new URL(currentUrl);
        }
        catch {
            throw new Error("Download refused: invalid URL");
        }
        if (parsed.protocol !== "https:") {
            throw new Error("Download refused: only https URLs are allowed");
        }
        await validateHost(parsed.hostname, lookup, signal);
        let response;
        try {
            response = await fetchImpl(currentUrl, { redirect: "manual", signal });
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error("Download refused: timed out");
            }
            throw new Error("Download refused: the request could not be completed");
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) {
                throw new Error("Download refused: redirect response missing a Location header");
            }
            redirectCount += 1;
            if (redirectCount > MAX_REDIRECTS) {
                throw new Error("Download refused: too many redirects");
            }
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Download refused: server responded with status ${response.status}`);
        }
        return readBodyCapped(response, maxBytes);
    }
}
