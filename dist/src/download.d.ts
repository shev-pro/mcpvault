/**
 * Downloads a remote file into memory for `uploadFile` (design brief:
 * .aicc/design/vault-upload.md, invariant I7). Every network-shaped
 * dependency (fetch, DNS lookup) is injectable so callers — and tests — never
 * have to touch the real network or real DNS to exercise the guard logic.
 *
 * Residual, documented rather than closed here: DNS rebinding between the
 * `lookup` validation and the `fetch` connect. Closing that gap needs a
 * custom dispatcher pinned to the already-checked IP; out of scope for this
 * change (brief §6).
 */
export type LookupFn = (hostname: string) => Promise<Array<{
    address: string;
    family: number;
}>>;
export interface DownloadOptions {
    maxBytes: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    lookup?: LookupFn;
}
/**
 * True when `ip` (a literal address, not a hostname) must never be reached by
 * an outbound download: loopback, RFC1918 private ranges, link-local, CGNAT
 * (100.64/10), unspecified, multicast, broadcast, IPv6 ULA (fc00::/7), and
 * the IPv4-mapped IPv6 form of any blocked IPv4 address. Hostnames (not IP
 * literals) always return false here — they are resolved and the resulting
 * addresses are checked individually by the caller.
 */
export declare function isBlockedAddress(ip: string): boolean;
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
export declare function downloadToBuffer(url: string, options: DownloadOptions): Promise<Uint8Array>;
//# sourceMappingURL=download.d.ts.map