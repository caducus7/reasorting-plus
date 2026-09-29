// Fetching an untrusted channel feed (brief C7 "Watch for"). SSRF defences, following OWASP's SSRF
// prevention guidance:
//   - https only in production; no other scheme, including on redirects;
//   - every address a connection is made to is checked AT CONNECT TIME (a custom DNS lookup on the
//     undici dispatcher), so DNS rebinding cannot swap in a private address after a check;
//     IP-literal hosts are checked before connecting (no lookup happens for them);
//   - only public unicast addresses (ipaddr.js range "unicast"; IPv4-mapped IPv6 unwrapped);
//   - redirects followed manually, at most 3, each through the same checks;
//   - a total timeout and a streamed body size limit.
import dns from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

export class FeedFetchError extends Error {}

export type FetchOptions = {
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number; // default 15 s
  maxBytes?: number; // default 5 MiB
  maxRedirects?: number; // default 3
  requireHttps?: boolean; // default true
  /** Address policy; default public unicast only. Tests pass an explicit allow list. */
  allowAddress?: (ip: string) => boolean;
};

export type FetchResult =
  | { status: 304 }
  | { status: 200; body: string; etag: string | null; lastModified: string | null; url: string };

export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let a = ipaddr.parse(ip);
  if (a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress()) a = (a as ipaddr.IPv6).toIPv4Address();
  return a.range() === "unicast";
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedAgent(allow: (ip: string) => boolean) {
  const lookup = (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = (addrs as dns.LookupAddress[]).filter((x) => allow(x.address));
      if (ok.length === 0) return cb(Object.assign(new Error(`no allowed address for ${hostname}`), { code: "EADDRBLOCKED" }));
      if (options.all) return cb(null, ok);
      cb(null, ok[0]!.address, ok[0]!.family);
    });
  };
  return new Agent({ connect: { lookup: lookup as never } });
}

function checkUrl(u: URL, o: Required<Pick<FetchOptions, "requireHttps">> & { allow: (ip: string) => boolean }) {
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FeedFetchError(`scheme ${u.protocol} not allowed`);
  if (o.requireHttps && u.protocol !== "https:") throw new FeedFetchError("feeds must use https");
  if (u.username || u.password) throw new FeedFetchError("credentials in feed URLs are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(host) && !o.allow(host)) throw new FeedFetchError(`address ${host} not allowed`);
}

export async function fetchFeed(url: string, o: FetchOptions = {}): Promise<FetchResult> {
  const allow = o.allowAddress ?? isPublicAddress;
  const requireHttps = o.requireHttps ?? true;
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const dispatcher = guardedAgent(allow);
  const signal = AbortSignal.timeout(o.timeoutMs ?? 15_000);
  let u = new URL(url);
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(u, { requireHttps, allow });
      const headers: Record<string, string> = { accept: "text/calendar, text/plain;q=0.9, */*;q=0.1", "user-agent": "booking-escrow-ical-sync/1" };
      if (o.etag) headers["if-none-match"] = o.etag;
      if (o.lastModified) headers["if-modified-since"] = o.lastModified;
      let r;
      try {
        r = await fetch(u, { headers, redirect: "manual", dispatcher, signal });
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        if (cause?.code === "EADDRBLOCKED") throw new FeedFetchError(`${cause.message}: not allowed`);
        throw new FeedFetchError(`fetch failed: ${cause?.message ?? (e as Error).message}`);
      }
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        await r.body?.cancel();
        const loc = r.headers.get("location");
        if (!loc) throw new FeedFetchError(`redirect ${r.status} without Location`);
        if (hop >= (o.maxRedirects ?? 3)) throw new FeedFetchError("too many redirects");
        u = new URL(loc, u);
        continue;
      }
      if (r.status === 304) {
        await r.body?.cancel();
        return { status: 304 };
      }
      if (r.status !== 200) {
        await r.body?.cancel();
        throw new FeedFetchError(`feed answered ${r.status}`);
      }
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > maxBytes) {
        await r.body?.cancel();
        throw new FeedFetchError(`feed larger than ${maxBytes} bytes`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const c of r.body ?? []) {
        size += (c as Uint8Array).byteLength;
        if (size > maxBytes) throw new FeedFetchError(`feed larger than ${maxBytes} bytes`);
        chunks.push(c as Uint8Array);
      }
      return {
        status: 200,
        body: Buffer.concat(chunks).toString("utf8"),
        etag: r.headers.get("etag"),
        lastModified: r.headers.get("last-modified"),
        url: u.toString(),
      };
    }
  } catch (e) {
    if (e instanceof FeedFetchError) throw e;
    if ((e as Error).name === "TimeoutError" || signal.aborted) throw new FeedFetchError("feed timed out");
    throw new FeedFetchError((e as Error).message);
  } finally {
    await dispatcher.close().catch(() => {});
  }
}
