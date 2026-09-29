// Every channel feed is untrusted input (brief C7 "Watch for"): size limits, timeouts, no redirects
// or connections to private address ranges, conditional GET. A local server stands in for a channel;
// the policy that admits it is the test-only allow list, and everything else is the production policy.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchFeed, FeedFetchError, isPublicAddress } from "../src/fetch.js";

let server: Server;
let base: string;
const hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = req.url ?? "/";
    hits[u] = (hits[u] ?? 0) + 1;
    if (u === "/feed.ics") {
      if (req.headers["if-none-match"] === '"v1"') return res.writeHead(304).end();
      return res.writeHead(200, { "content-type": "text/calendar", etag: '"v1"', "last-modified": "Tue, 29 Sep 2026 10:00:00 GMT" }).end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    }
    if (u === "/redirect-private") return res.writeHead(302, { location: "http://127.0.0.2:1/x" }).end();
    if (u === "/redirect-rfc1918") return res.writeHead(302, { location: "http://10.1.2.3/x" }).end();
    if (u === "/redirect-file") return res.writeHead(302, { location: "file:///etc/passwd" }).end();
    if (u.startsWith("/loop")) return res.writeHead(302, { location: `/loop${Number(u.slice(5) || 0) + 1}` }).end();
    if (u === "/redirect-ok") return res.writeHead(301, { location: "/feed.ics" }).end();
    if (u === "/huge") {
      res.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, 65);
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      return pump();
    }
    if (u === "/hang") return; // never answers
    if (u === "/500") return res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => void server.closeAllConnections?.(), 0);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// Test-only: admit exactly 127.0.0.1 and plain http. Production admits public unicast over https only.
const T = { allowAddress: (ip: string) => ip === "127.0.0.1", requireHttps: false };

describe("isPublicAddress (production policy)", () => {
  it("admits public unicast only", () => {
    for (const ip of ["8.8.8.8", "2606:4700:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "255.255.255.255"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetchFeed", () => {
  it("production policy refuses a loopback feed before connecting, by IP literal and by name", async () => {
    await expect(fetchFeed(`${base}/feed.ics`, { requireHttps: false })).rejects.toThrow(/not allowed/);
    await expect(fetchFeed(`${base.replace("127.0.0.1", "localhost")}/feed.ics`, { requireHttps: false })).rejects.toThrow(/not allowed|no allowed address/);
  });
  it("production policy refuses plain http and non-http schemes", async () => {
    await expect(fetchFeed("http://example.com/a.ics")).rejects.toThrow(/https/);
    await expect(fetchFeed("file:///etc/passwd", { requireHttps: false })).rejects.toThrow(/scheme/);
  });
  it("conditional GET: 200 with validators, then 304", async () => {
    const a = await fetchFeed(`${base}/feed.ics`, T);
    expect(a).toMatchObject({ status: 200, etag: '"v1"', lastModified: "Tue, 29 Sep 2026 10:00:00 GMT" });
    expect(a.status === 200 && a.body.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(await fetchFeed(`${base}/feed.ics`, { ...T, etag: '"v1"' })).toMatchObject({ status: 304 });
  });
  it("follows a same-policy redirect, refuses redirects to private ranges or other schemes, caps the chain", async () => {
    expect((await fetchFeed(`${base}/redirect-ok`, T)).status).toBe(200);
    await expect(fetchFeed(`${base}/redirect-private`, T)).rejects.toThrow(/not allowed/);
    await expect(fetchFeed(`${base}/redirect-rfc1918`, T)).rejects.toThrow(/not allowed/);
    await expect(fetchFeed(`${base}/redirect-file`, T)).rejects.toThrow(/scheme/);
    await expect(fetchFeed(`${base}/loop0`, T)).rejects.toThrow(/redirects/);
    expect(hits["/loop4"]).toBeUndefined(); // stopped after 3
  });
  it("aborts a body over the size limit, and a server that does not answer", async () => {
    await expect(fetchFeed(`${base}/huge`, { ...T, maxBytes: 1024 * 1024 })).rejects.toThrow(/larger than/);
    const t = Date.now();
    await expect(fetchFeed(`${base}/hang`, { ...T, timeoutMs: 500 })).rejects.toThrow(FeedFetchError);
    expect(Date.now() - t).toBeLessThan(3_000);
  });
  it("an error status is an error", async () => {
    await expect(fetchFeed(`${base}/500`, T)).rejects.toThrow(/500/);
  });
});
