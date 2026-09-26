# Running the chain agents

Give every agent the whole repo with `CLAUDE.md` (or `AGENTS.md`) at the root, and open its session
with: "Read CLAUDE.md, then briefs/<file>. Do only that package."

| Wave | Packages | Starts when |
|---|---|---|
| 1 | C0, C1 | Immediately, in parallel |
| 2 | C2, C3, C5, C9 | C1 has published its interfaces and events (interim handoff) |
| 3 | C4, C6 | C2 interface stable (C4); C1 to C3 ABIs stable (C6) |
| 4 | C7, C8 | C6 projections and head events available |

Rules for the person running them:

- C9 must be a fresh agent that has not seen C1 to C3's code or handoffs.
- Read every handoff's "Deviations", "Spec concerns" and "Blocked" sections before starting the
  next wave. An unanswered "Blocked" item on C1 blocks everything downstream.
- Interface changes (ADRs touching `IEscrow`, `IYieldAdapter`, events or the `/v1` schemas) need
  your sign-off. The `/v1` schemas also need the agent workstream's sign-off.
- After C1 to C3 and C9 are green, run one reviewer agent over `contracts/src/` against the spec,
  separate from every agent that wrote code. That is not a substitute for the external audit.
