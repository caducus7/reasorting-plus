// RFC 5545 feed parsing (brief C7 import), on Mozilla's ical.js. Every event becomes a block of
// property-local nights [from, to) with an exclusive end, which is how every channel treats check-out
// day (all-day DTEND is the check-out date). Ambiguities resolve towards blocking, never freeing.
//
// Time zones resolve per feed, never through ical.js's global TimezoneService, so one feed's
// VTIMEZONE cannot change how another feed is read:
//   UTC -> exact; TZID that is an IANA name -> tzdata (Luxon); other TZID with a VTIMEZONE in this
//   feed -> that definition; unknown TZID or floating time -> the property's own zone (warned).
import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { DateTime, IANAZone } from "luxon";

export class FeedParseError extends Error {}

export type Block = { ref: string; from: string; to: string; summary: string | null };
export type ParseResult = { blocks: Block[]; warnings: string[] };
export type ParseOptions = {
  tz: string; // the property's IANA zone
  now?: Date;
  horizonDays?: number; // recurrences are expanded this far ahead (default 730)
  maxEvents?: number; // VEVENTs accepted per feed (default 5000)
  maxOccurrences?: number; // per recurring event (default 1000)
  keepPastDays?: number; // blocks that ended longer ago are dropped (default 30)
};

type T = InstanceType<typeof ICAL.Time>;
type Comp = InstanceType<typeof ICAL.Component>;

export function parseFeed(text: string, o: ParseOptions): ParseResult {
  const now = o.now ?? new Date();
  const horizon = DateTime.fromJSDate(now).plus({ days: o.horizonDays ?? 730 });
  const warnings: string[] = [];
  let root: Comp;
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown as unknown[]);
  } catch (e) {
    throw new FeedParseError(`not an iCalendar document: ${(e as Error).message}`);
  }
  if (root.name !== "vcalendar") throw new FeedParseError(`root component is ${root.name}, not VCALENDAR`);
  const events = root.getAllSubcomponents("vevent");
  if (events.length > (o.maxEvents ?? 5_000)) throw new FeedParseError(`too many events (${events.length})`);

  const vtz = new Map<string, InstanceType<typeof ICAL.Timezone>>();
  for (const c of root.getAllSubcomponents("vtimezone")) {
    const id = c.getFirstPropertyValue("tzid");
    if (typeof id === "string") vtz.set(id, new ICAL.Timezone({ component: c, tzid: id }));
  }

  // The property-local date of a DATE-TIME (or the wall date of a DATE).
  const localDate = (t: T, tzid: string | null, utc: boolean): string => {
    const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second };
    if (t.isDate) return DateTime.fromObject(wall, { zone: "utc" }).toISODate()!;
    let at: DateTime;
    if (utc) at = DateTime.fromObject(wall, { zone: "utc" });
    else if (tzid && IANAZone.isValidZone(tzid)) at = DateTime.fromObject(wall, { zone: tzid });
    else if (tzid && vtz.has(tzid)) {
      at = DateTime.fromSeconds(ICAL.Time.fromData({ ...wall, isDate: false }, vtz.get(tzid)).toUnixTime());
    } else {
      if (tzid) warnings.push(`unknown TZID "${tzid}" without VTIMEZONE: read in ${o.tz}`);
      at = DateTime.fromObject(wall, { zone: o.tz });
    }
    return at.setZone(o.tz).toISODate()!;
  };
  const nextDay = (d: string) => DateTime.fromISO(d, { zone: "utc" }).plus({ days: 1 }).toISODate()!;
  const cutoff = DateTime.fromJSDate(now).setZone(o.tz).minus({ days: o.keepPastDays ?? 30 }).toISODate()!;

  const blocks: Block[] = [];
  const seen = new Map<string, number>();
  const push = (ref: string, from: string, to: string, summary: string | null) => {
    if (to <= from) to = nextDay(from); // same-day or inverted: block that night (conservative)
    if (to < cutoff) return;
    const n = seen.get(ref) ?? 0;
    seen.set(ref, n + 1);
    blocks.push({ ref: n === 0 ? ref : `${ref}#dup${n}`, from, to, summary });
  };

  // Group by UID so RECURRENCE-ID overrides attach to their master (RFC 5545 3.8.4.4).
  const masters: Comp[] = [];
  const overrides = new Map<string, Comp[]>();
  for (const ev of events) {
    const uid = ev.getFirstPropertyValue("uid");
    if (ev.hasProperty("recurrence-id") && typeof uid === "string") {
      overrides.set(uid, [...(overrides.get(uid) ?? []), ev]);
    } else masters.push(ev);
  }

  for (const comp of masters) {
    if (String(comp.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
    const startProp = comp.getFirstProperty("dtstart");
    if (!startProp) {
      warnings.push("event without DTSTART ignored");
      continue;
    }
    const tzid = (startProp.getParameter("tzid") as string | undefined) ?? null;
    const start = startProp.getFirstValue() as T;
    const utc = !start.isDate && /Z$/i.test(String(startProp.toICALString()));
    const endProp = comp.getFirstProperty("dtend");
    const endTzid = (endProp?.getParameter("tzid") as string | undefined) ?? tzid;
    const endUtc = endProp ? /Z$/i.test(String(endProp.toICALString())) : utc;
    const summary = (comp.getFirstPropertyValue("summary") as string | null) ?? null;
    let uid = comp.getFirstPropertyValue("uid") as string | null;
    if (!uid) {
      const raw = ["dtstart", "dtend", "summary"].map((p) => comp.getFirstProperty(p)?.toICALString() ?? "").join("|");
      uid = `nouid:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
    }

    const event = new ICAL.Event(comp, { exceptions: overrides.get(uid) ?? [] });
    // Duration: DTEND, else DURATION, else one day (all-day) or zero (timed, then one night).
    const dur = endProp || comp.hasProperty("duration") ? event.duration : ICAL.Duration.fromData({ days: start.isDate ? 1 : 0 });
    const blockOf = (s: T, e: T | null) => {
      const end = e ?? (() => {
        const x = s.clone();
        x.addDuration(dur);
        return x;
      })();
      return [localDate(s, tzid, utc), localDate(end, e ? endTzid : tzid, e ? endUtc : utc)] as const;
    };

    if (!event.isRecurring()) {
      const end = endProp ? (endProp.getFirstValue() as T) : null;
      const [from, to] = blockOf(start, end);
      push(uid, from, to, summary);
      continue;
    }
    const it = event.iterator();
    let occ: T | null;
    let count = 0;
    while ((occ = it.next())) {
      if (++count > (o.maxOccurrences ?? 1_000)) {
        warnings.push(`recurrence of ${uid} truncated at ${o.maxOccurrences ?? 1_000} occurrences`);
        break;
      }
      const d = event.getOccurrenceDetails(occ);
      if (DateTime.fromJSDate(d.startDate.toJSDate()) > horizon) break;
      if (String(d.item.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
      const [from, to] = blockOf(d.startDate, d.endDate);
      const key = occ.isDate ? occ.toString() : localDate(occ, tzid, utc);
      push(`${uid}#${key}`, from, to, summary);
    }
  }
  return { blocks, warnings };
}
