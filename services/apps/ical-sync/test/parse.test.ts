// Brief C7 test 1: parser fixtures in the channels' export formats, including DST-crossing stays in
// Europe/Athens. Every block is normalised to property-local nights [from, to), DTEND exclusive.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFeed, FeedParseError } from "../src/parse.js";

const TZ = "Europe/Athens";
const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const nights = (text: string) =>
  Object.fromEntries(parseFeed(text, { tz: TZ }).blocks.map((b) => [b.ref, [b.from, b.to]]));

describe("parseFeed", () => {
  it("Airbnb: all-day reservations and host blocks, exclusive DTEND, back-to-back stays, folded lines", () => {
    const r = parseFeed(fx("airbnb.ics"), { tz: TZ });
    expect(r.blocks.map((b) => [b.from, b.to])).toEqual([
      ["2026-10-23", "2026-10-27"], // 4 nights across the October DST change: dates are not shifted
      ["2026-10-27", "2026-10-30"], // check-in on the previous check-out day: no overlap
      ["2026-11-24", "2026-12-01"],
    ]);
    expect(r.blocks[0]!.ref).toBe("1418fb94e984-3a9f0c1d2e4b5a6978c0d1e2f3a4b5c6@airbnb.com");
    expect(r.warnings).toEqual([]);
  });

  it("Booking.com: closed dates, including a stay across the March DST change", () => {
    expect(Object.values(nights(fx("booking.ics")))).toEqual([
      ["2027-03-26", "2027-03-30"],
      ["2026-11-02", "2026-11-03"],
    ]);
  });

  it("timed events: VTIMEZONE, UTC, floating, IANA TZID without VTIMEZONE, missing DTEND, same-day, cancelled, RRULE/EXDATE", () => {
    const r = parseFeed(fx("edge.ics"), { tz: TZ });
    const n = Object.fromEntries(r.blocks.map((b) => [b.ref, [b.from, b.to]]));
    expect(n).toEqual({
      "timed-fallback": ["2026-10-23", "2026-10-27"], // 15:00 in, 11:00 out, across fall-back
      "utc-spring": ["2027-03-26", "2027-03-29"], // 15:00 EET in, 11:00 EEST out
      "utc-late-evening": ["2026-10-25", "2026-10-26"], // 22:00Z is 01:00 the next day in Athens
      floating: ["2026-11-10", "2026-11-12"], // the property's own zone
      "iana-no-vtimezone": ["2026-12-06", "2026-12-07"], // New York evening = Athens early morning
      "no-dtend": ["2026-12-15", "2026-12-16"], // all-day, no DTEND: one night
      "same-day": ["2026-12-18", "2026-12-19"], // blocks that night, conservatively
      "weekly#2027-01-05": ["2027-01-05", "2027-01-06"],
      "weekly#2027-01-19": ["2027-01-19", "2027-01-20"], // 2027-01-12 excluded by EXDATE
    });
    expect(n).not.toHaveProperty("cancelled");
  });

  it("an unknown TZID without VTIMEZONE falls back to the property zone and says so", () => {
    const text = fx("edge.ics").replace("TZID=America/New_York", "TZID=Customized Time Zone");
    const r = parseFeed(text, { tz: TZ });
    expect(r.blocks.find((b) => b.ref === "iana-no-vtimezone")).toMatchObject({ from: "2026-12-05", to: "2026-12-06" });
    expect(r.warnings.some((w) => /Customized Time Zone/.test(w))).toBe(true);
  });

  it("an event without UID gets a stable content-derived ref", () => {
    const text = fx("booking.ics").replace(/UID:0b1c[^\r]*\r\n/, "");
    const a = parseFeed(text, { tz: TZ }).blocks.find((b) => b.from === "2026-11-02")!;
    const b = parseFeed(text, { tz: TZ }).blocks.find((b) => b.from === "2026-11-02")!;
    expect(a.ref).toMatch(/^nouid:/);
    expect(a.ref).toBe(b.ref);
  });

  it("untrusted input: garbage, a non-calendar, and too many events are rejected, never half-applied", () => {
    expect(() => parseFeed("not a calendar", { tz: TZ })).toThrow(FeedParseError);
    expect(() => parseFeed("BEGIN:VCARD\r\nEND:VCARD\r\n", { tz: TZ })).toThrow(FeedParseError);
    const ev = (i: number) => `BEGIN:VEVENT\r\nUID:e${i}\r\nDTSTART;VALUE=DATE:20270101\r\nEND:VEVENT\r\n`;
    const big = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${Array.from({ length: 11 }, (_, i) => ev(i)).join("")}END:VCALENDAR\r\n`;
    expect(() => parseFeed(big, { tz: TZ, maxEvents: 10 })).toThrow(/too many/);
    const rr = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:r\r\nDTSTART;VALUE=DATE:20270101\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    expect(parseFeed(rr, { tz: TZ, horizonDays: 30, now: new Date("2027-01-01T00:00:00Z") }).blocks.length).toBeLessThanOrEqual(31);
  });

  it("a non-IANA TZID is read with the feed's own VTIMEZONE (not the property zone)", () => {
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0",
      "BEGIN:VTIMEZONE", "TZID:Custom Plus Five", "BEGIN:STANDARD", "TZOFFSETFROM:+0500", "TZOFFSETTO:+0500",
      "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:vtz", "DTSTART;TZID=Custom Plus Five:20261201T020000",
      "DTEND;TZID=Custom Plus Five:20261203T020000", "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
    // 02:00 at +05:00 is 21:00Z on 30 Nov, 23:00 in Athens: the night of 30 Nov. Read as Athens it
    // would wrongly start on 1 Dec.
    const r = parseFeed(ics, { tz: TZ });
    expect(r.blocks).toEqual([{ ref: "vtz", from: "2026-11-30", to: "2026-12-02", summary: null }]);
    expect(r.warnings).toEqual([]);
  });
});
