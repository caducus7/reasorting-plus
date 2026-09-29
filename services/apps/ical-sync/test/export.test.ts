// Export feed format and access (brief C7 export): one unguessable URL per resource and channel,
// all-day events with an exclusive DTEND in the property's zone, "Reserved" only, nothing that links
// to a guest (not even the on-chain bookingId), conditional GET.
import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import { buildCalendar, createExportApp, exportToken, exportUid, type Exportable } from "../src/export.js";

const SECRET = "x".repeat(48);
const R = `0x${"a1".repeat(32)}`;
const B = `0x${"b1".repeat(32)}`;
const bookings: Exportable[] = [
  { bookingId: B, checkInUtc: 1_792_933_200n, checkOutUtc: 1_793_178_000n, depositTimestamp: 1_790_000_000n }, // 25 -> 28 Oct, across DST
];

describe("export tokens", () => {
  it("are per resource and channel, stable, 256-bit, and unrelated across pairs", () => {
    const a = exportToken(SECRET, R, "airbnb");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exportToken(SECRET, R, "airbnb")).toBe(a);
    expect(exportToken(SECRET, R, "booking")).not.toBe(a);
    expect(exportToken("y".repeat(48), R, "airbnb")).not.toBe(a);
  });
});

describe("buildCalendar", () => {
  it("emits all-day Reserved events with exclusive DTEND and no guest-linkable data", () => {
    const text = buildCalendar(bookings, { tz: "Europe/Athens", secret: SECRET, name: "Villa" });
    const cal = new ICAL.Component(ICAL.parse(text) as unknown as unknown[]);
    const [ev] = cal.getAllSubcomponents("vevent");
    expect(ev!.getFirstPropertyValue("summary")).toBe("Reserved");
    expect(String(ev!.getFirstPropertyValue("dtstart"))).toBe("2026-10-25");
    expect(String(ev!.getFirstPropertyValue("dtend"))).toBe("2026-10-28");
    expect(ev!.getFirstPropertyValue("uid")).toBe(exportUid(SECRET, B));
    expect(text.toLowerCase()).not.toContain(B.slice(2, 20));
    expect(text).toMatch(/\r\n/); // CRLF per RFC 5545
    expect(buildCalendar(bookings, { tz: "Europe/Athens", secret: SECRET, name: "Villa" })).toBe(text); // deterministic
  });
});

describe("export endpoint", () => {
  const app = createExportApp({
    secret: SECRET,
    pairs: [{ resourceId: R, channel: "airbnb" }],
    zones: new Map([[R, "Europe/Athens"]]),
    names: new Map([[R, "Villa"]]),
    exportable: async (r) => (r === R ? bookings : []),
  });
  it("serves text/calendar for a valid token, 404 otherwise, and 304 on a matching ETag", async () => {
    const tok = exportToken(SECRET, R, "airbnb");
    const ok = await app.request(`/ical/${tok}.ics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/calendar/);
    const etag = ok.headers.get("etag")!;
    expect((await app.request(`/ical/${tok}.ics`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await app.request(`/ical/${exportToken(SECRET, R, "booking")}.ics`)).status).toBe(404); // unconfigured channel
    expect((await app.request(`/ical/${"A".repeat(43)}.ics`)).status).toBe(404);
    expect((await app.request(`/ical/short.ics`)).status).toBe(404);
  });
});
