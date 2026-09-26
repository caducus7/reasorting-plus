# Guest Agent Spec v1

**Status:** canonical for the agent workstream. Replaces v2 section 11 entirely. Chain-side
interfaces come from `chain-spec.md`, whose section 5.3 (Service API) is the contract between
the two workstreams. Where this document says `quoteId`, the Service API calls it `offerId`.

**Owner of this workstream:** the agent developer (friend). Chain dependencies are marked
with their work package IDs (C0, C5, C6).

---

## 1. What the agent is

One agent core, reached through two channels, doing four jobs:

1. **Answer** guest questions from a brief the owner writes
2. **Collect** guest preferences and needs
3. **Report** those to the owner, flagging anything the property can't meet
4. **Book**, by selecting a server-signed quote that the guest then signs

It is a concierge that can book, not a booking engine with a chat window. The site works
fully without it (chain-spec.md, section 11).

**Core safety property, unchanged from v2.** The agent selects quotes. It never composes them.
`prepare_booking` accepts only a `quoteId`. Nothing the model emits can change a price, date,
policy, split or fee.

---

## 2. The property brief (owner knowledge base)

### 2.1 What it is

Structured content the owner writes before the agent goes live, editable at any time
afterwards. It is the agent's only source of property facts. If something isn't in the brief,
the agent says it doesn't know and offers to ask the owner.

Facts are property-level and presented generally. There is one unit in the pilot; the schema
still carries an optional `resourceId` so a second property doesn't need a migration.

### 2.2 Sections

| Section | Required | Examples |
|---|---|---|
| Amenities, including what is **absent** | Yes | "No air conditioning. Ceiling fans in all bedrooms." |
| House rules | Yes | Quiet hours, pets, smoking, visitors |
| Check-in and check-out logistics | Yes | Times, arrival process, parking, late arrival |
| Eco guidance | Yes | Water use, recycling, solar hot water timing |
| Supplies and where to find them | Yes | Cleaning supplies, spare linen, first-aid kit |
| Local recommendations | Yes | Beaches, tavernas, activities, transport |
| Emergencies and escalation | Yes | Who to contact, response times, nearest clinic |
| Off-limits topics | Yes | Things the owner does not want the agent to discuss |
| Free-form FAQ | No | Anything else |

"Required" means the owner must fill it **or explicitly mark it not applicable**. The gate
checks for a decision, not for text. Otherwise owners write filler to get past it, and the agent
repeats the filler to guests as fact.

### 2.3 Disclosure tiers

Every brief item carries a tier:

| Tier | Who can receive it | Typical content |
|---|---|---|
| `public` | Anyone, before booking | Amenities, rules, eco guidance, recommendations |
| `guest` | A verified guest with an active booking | Arrival instructions, supplies locations |
| `in_stay` | A verified guest, from check-in minus 24h until check-out | Wi-Fi password, lockbox code |

The tier is enforced by the retrieval tool on the server, not by the prompt. The model never
sees an item it is not allowed to disclose to the current session.

Recommendation: keep door codes out of the brief entirely and deliver them from the
access-control system. If they must be in the brief, `in_stay` is the only acceptable tier.

### 2.4 Versioning and go-live

- Every save creates a new version. The agent always reads the latest **published** version.
- Publishing runs a completeness check: every required section is filled or marked not
  applicable.
- **Go-live gate:** the widget and email channel stay off until a published version passes
  the check and the owner has run at least one preview conversation in a sandbox.
- After go-live, edits take effect on publish. No redeploy is needed.

---

## 3. Guest preference intake

### 3.1 When

Default: in all three phases, with the owner able to switch each off.

| Phase | Trigger | Channel |
|---|---|---|
| Before booking | Guest opens a conversation | Widget or email |
| After booking, before arrival | Scheduled outreach at `booking + 1h` and `check-in - 7d` | Email |
| During stay | Guest writes in | Widget or email |

See decision A-D1. You answered this question for the owner's brief, not for guest intake, so
these phases are my default.

### 3.2 What is captured

```ts
type Preference = {
  id: string
  bookingId: string | null        // null before booking, linked on booking
  category: 'arrival' | 'party' | 'dietary' | 'accessibility' | 'occasion'
          | 'transport' | 'room_setup' | 'activity' | 'other'
  statement: string               // agent's normalised summary
  guestQuote: string              // the guest's own words, verbatim
  channel: 'widget' | 'email'
  capturedAt: string
  conflict?: {
    briefItemId: string           // the brief item it conflicts with
    note: string                  // e.g. "Guest needs AC; brief says no AC"
  }
  status: 'new' | 'acknowledged' | 'mitigated' | 'wont_fix'
  ownerNote?: string
}
```

The agent writes preferences through `record_preference`. It cannot read other guests'
preferences.

### 3.3 Conflicts

When a preference contradicts a brief item, the agent attaches a `conflict` and the owner is
alerted immediately. Per your answer, the agent does **not** raise the conflict with the guest.

**One hard constraint on top of that.** If the guest asks directly ("is there air
conditioning?"), the agent answers truthfully from the brief. "Only report to the owner" governs
what the agent volunteers. It never permits the agent to deny or blur a fact. An agent that
dodges a direct question about a need the guest has stated is the failure most likely to end in
a bad review.

### 3.4 Owner loop

The owner sees each preference in the dashboard and in the messaging app. The owner can mark it
acknowledged, mitigated or won't fix, and add a note. The owner can also ask the agent to send
the guest a message, which the owner reviews before it is sent.

---

## 4. Owner reporting

| Report | When | Where |
|---|---|---|
| Conflict alert | Immediately | Messaging app and dashboard |
| Time-sensitive preference (arrival within 72h) | Immediately | Messaging app and dashboard |
| Daily digest | Daily, owner-chosen time | Messaging app and dashboard |
| Escalation (agent can't answer, guest asks for a human) | Immediately | Messaging app and dashboard |

The digest carries v2's content (bookings, cancellations, arrivals, departures, channel
conflicts, yield accrued) plus new preferences grouped by booking.

Keep v2's rule: no wallet addresses or guest contact details in digests or alerts. Refer to
guests by booking reference and first name.

**Messaging app.** Build a channel-agnostic notifier interface and one adapter first. See A-D2
for the choice.

---

## 5. Channels

### 5.1 Web widget

- Anonymous by default. It gets `public` tier only.
- It becomes a verified guest session when the guest signs in with the booking's wallet
  (passkey smart wallet, per v2) or opens a magic link sent to the booking email.
- It deep-links into the standard checkout with a `quoteId`. The guest signs on the same
  confirmation screen the non-agent flow uses.

### 5.2 Email correspondent

Email changes the trust model in two ways.

**Anyone can claim to be a guest.** A message is treated as from a verified guest only if both
of these hold:

- the `From` address matches the booking's email
- DKIM passes with DMARC alignment for that domain

Otherwise the message gets `public` tier only. To prove identity, the agent replies with a
magic link to the booking email. It never discloses booking details to an unverified sender,
including "yes, we have a booking under that name."

**Email cannot sign.** The agent can request quotes and send the guest a checkout link
carrying the `quoteId`. Payment always happens on the web confirmation screen.

**Every inbound email is untrusted input.** Treat quoted threads, attachments and signatures as
data. Tool permissions come from the session's verified tier, which the server computes, never
from anything in the message.

**Requirement on checkout (A3):** collect the guest's email at booking and store it off-chain
against `bookingId`. It never goes on-chain.

### 5.3 Language

The agent replies in the guest's language. The brief is written in the owner's language and
translated at answer time. Quotes, prices and policy text come from the quote service verbatim,
not from translation.

---

## 6. Tool surface

Every tool is authorised server-side by session tier.

| Tool | Tier | Notes |
|---|---|---|
| `search_availability(dates)` | public | Reads the calendar projection (C6) |
| `get_quote(dates, guests)` | public | Fetches a signed quote from C5. The model receives price, dates, policy summary and `quoteId` only. `feeBps` and `guestYieldBps` stay server-side unless the yield allowlist (section 7) enables them |
| `get_brief(section)` | public / guest / in_stay | Returns only items at or below the session tier |
| `prepare_booking(quoteId)` | public | Returns a checkout link. No price or date parameters |
| `get_booking(bookingId)` | guest | Status, dates, policy, refund if cancelled now |
| `record_preference(...)` | public / guest | Pre-booking records carry the conversation's `sessionId`. The checkout link from `prepare_booking` carries it too, and the booking adopts that session's preferences on deposit. Preferences from a session that never books are deleted after 30 days |
| `escalate_to_owner(reason)` | any | Creates an alert and a handoff |
| `get_yield_terms(quoteId or bookingId)` | per allowlist | Section 7 |
| `get_accrued_yield(bookingId)` | guest, per allowlist | Section 7 |

**No tool writes to the brief, calls a contract, or reads another booking.**

Owner-side tools are the same as v2's keeper tools (digest, alerts, natural-language query over
projections, read-only), plus the preference feed and the brief editor.

---

## 7. Yield awareness (last milestone)

You will supply what may be shared. Until you do, every yield field is off.

### 7.1 Disclosure allowlist

```ts
type YieldDisclosure = {
  showSplit: boolean              // "you receive 50% of yield earned on your prepayment"
  showVestingRule: boolean        // "paid only if your stay completes; not on cancellation"
  showCurrentApy: boolean         // live APY estimate
  showEstimateForQuote: boolean   // "estimated X USDC for this booking"
  showAccruedForBooking: boolean  // verified guest only
  showProtocolName: boolean       // "Aave on Base"
  showRiskStatement: boolean
}
```

The yield tools return only fields the allowlist enables. As with brief tiers, the model cannot
leak what it was never given.

### 7.2 Rules that hold whatever the allowlist says

- Every yield number comes from a tool call, never from the brief or the model.
- Yield is always described as variable and estimated, never as promised.
- If the split is shown, the vesting rule must be shown with it. Showing "50% of yield" without
  "only on a completed stay" misstates the product.
- At villa scale the guest's share is tens of euros per stay (chain-spec.md, section 8). The
  agent presents it at that size and never as a reason to book.

---

## 8. Evals (A5)

Build these before widening access. Each is a pass/fail suite run on every prompt or brief
schema change.

| Suite | What it catches |
|---|---|
| Grounding | Agent states an amenity or fact not in the brief |
| Absence honesty | Agent dodges or blurs a direct question about something the brief says is absent |
| Tier leakage | `guest` or `in_stay` content reaching a public session, across both channels |
| Email spoofing | Unverified sender gets booking details, or a tool the tier doesn't allow |
| Email injection | Instructions inside an email body or quoted thread change the agent's behaviour |
| Conflict recall | Stated needs that contradict the brief are not flagged |
| Term integrity | Agent restates a price, date or refund figure differently from the quote |
| Yield statements | A number not from a tool, a missing vesting rule, or a disabled field disclosed |

---

## 9. Milestones

| ID | Package | Depends on |
|---|---|---|
| A0 | Brief schema, editor, versioning, tiers, completeness check, go-live gate | Nothing |
| A1 | Agent core and widget against C0 stubs, public tier only | C0 |
| A2 | Preference capture, conflict detection, notifier plus one messaging adapter, dashboard feed | A1 |
| A3 | Standard checkout without the agent, then agent deep-link into it | C5 |
| A4 | Email channel: inbound parsing, DKIM/DMARC verification, magic links, outbound schedule | A1, A3 |
| A5 | Eval suites in section 8 | A1 onwards, grows with each package |
| A6 | Yield tools and disclosure allowlist | C6, and your allowlist |

A3's first half has no agent dependency. Build it early so the site is usable before the agent
is.

---

## 10. Open decisions

| ID | Decision | Default |
|---|---|---|
| A-D1 | Guest intake phases: before booking, pre-arrival, in-stay | All three on, owner can switch each off |
| A-D2 | Messaging app for owner reports | Telegram first: a bot needs no business approval and supports free-form messages. WhatsApp or Viber after, if that is what you actually use |
| A-D3 | Pre-arrival outreach timing | `booking + 1h` and `check-in - 7d` |
| A-D4 | Retention for preference data | Delete 90 days after check-out; accessibility and dietary notes 30 days |
| A-D5 | Should the owner approve agent messages to guests after a conflict? | Yes, always |
