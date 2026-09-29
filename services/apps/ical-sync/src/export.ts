// Export feeds (brief C7, spec 9): per resource and channel, our escrow bookings once the deposit is
// at the safe head, removed on cancellation (once the cancellation is at safe: ADR 0017 §2).
// Privacy: SUMMARY "Reserved" only; the UID is an HMAC of the bookingId, because the bookingId itself
// is public on-chain and would link a channel's calendar to the guest's wallet.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import ICAL from "ical.js";
import { DateTime } from "luxon";

export type Exportable = { bookingId: string; checkInUtc: bigint; checkOutUtc: bigint; depositTimestamp: bigint };
export type ExportPair = { resourceId: string; channel: string };

const b64u = (b: Buffer) => b.toString("base64url");

/** The unguessable path token for one (resource, channel): HMAC-SHA256, 256 bits. Rotating the
 * secret rotates every URL. */
export function exportToken(secret: string, resourceId: string, channel: string): string {
  return b64u(createHmac("sha256", secret).update(`ical-export:v1:${resourceId.toLowerCase()}:${channel}`).digest());
}

export function exportUid(secret: string, bookingId: string): string {
  return `${createHmac("sha256", secret).update(`ical-uid:v1:${bookingId.toLowerCase()}`).digest("hex").slice(0, 32)}@escrow.invalid`;
}

const date = (t: bigint, tz: string) => DateTime.fromSeconds(Number(t), { zone: tz }).toISODate()!;

export function buildCalendar(bookings: Exportable[], o: { tz: string; secret: string; name: string }): string {
  const cal = new ICAL.Component(["vcalendar", [], []]);
  cal.addPropertyWithValue("prodid", "-//Booking Escrow//iCal export 1//EN");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("calscale", "GREGORIAN");
  cal.addPropertyWithValue("method", "PUBLISH");
  cal.addPropertyWithValue("x-wr-calname", o.name);
  const rows = bookings
    .map((b) => ({ uid: exportUid(o.secret, b.bookingId), from: date(b.checkInUtc, o.tz), to: date(b.checkOutUtc, o.tz), stamp: b.depositTimestamp }))
    .sort((a, b) => (a.from === b.from ? (a.uid < b.uid ? -1 : 1) : a.from < b.from ? -1 : 1));
  for (const r of rows) {
    const ev = new ICAL.Component("vevent");
    ev.addPropertyWithValue("uid", r.uid);
    ev.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(Number(r.stamp) * 1000), true));
    ev.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(r.from));
    // All-day DTEND is exclusive: the check-out date (RFC 5545 3.6.1), as every channel reads it.
    ev.addPropertyWithValue("dtend", ICAL.Time.fromDateString(r.to <= r.from ? DateTime.fromISO(r.from).plus({ days: 1 }).toISODate()! : r.to));
    ev.addPropertyWithValue("summary", "Reserved");
    ev.addPropertyWithValue("transp", "OPAQUE");
    cal.addSubcomponent(ev);
  }
  return cal.toString().replace(/\r?\n/g, "\r\n") + "\r\n";
}

export type ExportDeps = {
  secret: string;
  pairs: ExportPair[];
  zones: Map<string, string>;
  names: Map<string, string>;
  exportable: (resourceId: string) => Promise<Exportable[]>;
};

export function createExportApp(d: ExportDeps) {
  const tokens = d.pairs.map((p) => ({ ...p, token: Buffer.from(exportToken(d.secret, p.resourceId, p.channel)) }));
  const app = new Hono();
  app.get("/ical/:file", async (c) => {
    const m = /^([A-Za-z0-9_-]{43})\.ics$/.exec(c.req.param("file"));
    const given = m ? Buffer.from(m[1]!) : null;
    // Constant-time over every configured token; unknown and malformed look the same.
    const hit = given ? tokens.find((t) => t.token.length === given.length && timingSafeEqual(t.token, given)) : undefined;
    if (!hit) return c.text("not found", 404);
    const r = hit.resourceId.toLowerCase();
    const tz = d.zones.get(r);
    if (!tz) return c.text("not found", 404);
    const body = buildCalendar(await d.exportable(r), { tz, secret: d.secret, name: d.names.get(r) ?? "Calendar" });
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    const headers = { etag, "cache-control": "private, max-age=60", "x-robots-tag": "noindex" };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    return c.body(body, 200, { ...headers, "content-type": "text/calendar; charset=utf-8" });
  });
  return app;
}
