# DESIGN.md

Visual design system for the Loop dashboard. **Signal Grid** — an observability-style light theme, chosen over the vault's original shared dark tokens (Fraud Radar's) after a design-consultation review against a terminal/ops-console reference. Kept as its own system rather than inheriting the shared dark tokens because the product's own differentiator (correctness you can audit — guardrails, reasoning, reconciled balances) reads better as something you can point at in daylight than as a hacker-console screen.

## Classifier

**App UI** (data-dense, task-focused workspace) — not a marketing page. Scanned and operated, not read top-to-bottom: summary before detail, state encoded in chips/badges as well as numbers.

## Color

CSS variables, semantic naming:

```css
--bg: #f3f5fa;          /* cool light neutral, not pure white */
--panel: #ffffff;        /* card/table surface */
--border: #dde2ee;
--text: #111827;
--muted: #606a80;
--accent: #4147c4;       /* interactive elements only — flat, never a gradient */
--ok: #15803d;           /* routed / completed / clear */
--ok-bg: #eafbf1;
--warn: #b45309;         /* received / pending_approval / needs review */
--warn-bg: #fef3e2;
--error: #c0332b;        /* failed */
--error-bg: #fdeceb;
--neutral-bg: #eef0f4;   /* rejected — a deliberate non-outcome, not a failure */
```

Semantic color (ok/warn/error) is kept separate from the accent hue — the accent marks "interactive," not "state." All colors meet 4.5:1 contrast on body text.

## Typography

Three roles, loaded via `next/font/google` (self-hosted, no runtime font-loading waterfall — the previous dark theme referenced IBM Plex Sans in CSS but never actually loaded it, so it silently fell back to system-ui the whole time):

- **Lexend** — display/label face: brand, nav, panel headers, section titles, KPI numbers. Geometric and distinct without being one of the flagged "safe defaults" (Inter, Space Grotesk).
- **Public Sans** — body copy, form inputs, reasoning text.
- **IBM Plex Mono** — anything tabular or identifier-shaped: order IDs, timestamps, points, latencies. `font-variant-numeric: tabular-nums` wherever digits line up in columns.

## Layout

Sticky top bar (brand + live environment chip, no nav links — stays pinned while the page scrolls) → a 4-tile KPI row → a full-width order thread table → a full-width panel below (storefront audit), all on a single page. An earlier iteration split this into a sidebar with separate Orders/Agents/Audit routes; reverted back to the single page since the extra navigation added no value here — everything fits on one screen and the "dead nav link" problem it was meant to solve (anchor-scroll links with nothing below to scroll to on shorter pages) is moot once there's nothing to navigate between.

**Agent activity is a tooltip-style card, not a standing panel.** Clicking an order row (or placing a demo order) opens a floating card anchored to the top-right of the order thread panel — `position: absolute` inside the panel's own box, so it overlays the table rather than pushing page content down or requiring extra viewport width. It shows the selected order's retention decision plus the full pending-approval queue (with Approve/Reject), exactly what used to live in an always-visible panel below the table — only the presentation changed, not the data. Dismissed via an explicit × close button; the underlying order selection and ledger detail stay visible either way.

**KPI tiles are combo cards, not a 1:1 metric-to-tile mapping.** Six real metrics compress into 4 tiles by pairing metrics that describe the same subject: "Selected order" leads with the loyalty balance and carries order status + order ID as a secondary readout; "Retention agent" leads with the approval-queue size and carries the eval pass rate as a secondary readout. Webhook success and event lag stay as their own tiles since neither pairs naturally with anything else. No metric was dropped — the secondary readout (a smaller line below a dashed divider) is how a combo card keeps both numbers visible. A tile with nothing to show yet renders `—` and a one-line note, never a fake placeholder number.

**Order thread table** spans the full page width and lists every order for the tenant, live via the orders WS feed, 12 rows per page with Prev/Next controls once there are more than 12. Rows are clickable (`role="button" tabIndex={0}` + `onKeyDown` for Enter/Space) — selecting one drives the KPI row's "Selected order" tile and expands a ledger + retention-decision detail block beneath the table, via the same per-order WebSocket thread used for the "place a demo order" flow.

**Demo controls** live in their own card (not loose buttons on the page background), matching every other section's panel treatment. "Place a demo order" stays the solid-accent primary action; "Seed stale orders (win-back)" and "Seed high-value lapsed customer" use a new `button.ghost` variant (accent-colored outline + text, transparent fill) — deliberately louder than `.secondary`'s flat grey (reserved for low-stakes actions like Prev/Next/Reject) so a seed action reads as a distinct, purposeful control rather than a muted afterthought. A vertical divider separates the primary action from the two seed utilities, and a caption underneath explains what seeding does before anyone has to click to find out. Both seed buttons call admin endpoints that insert backdated order history and immediately trigger the retention batch sweep, so the win-back and approval-queue paths don't require waiting on the real 24h schedule. Both go through the real Gemini call — no synthetic decisions — so the approval-queue button is disclosed as "not a guarantee" (a status line under the buttons reports what happened) rather than promising a `pending_approval` row every click.

**Cards carry a subtle shadow** (`0 1px 2px rgba(17,24,39,0.04)` on `.panel` and `.kpi`) on top of the existing border — enough to lift them off the `--bg` ground without introducing a heavier, more decorative shadow language than the rest of the light-observability system uses.

## Information hierarchy

**Primary**: the KPI row (system state at a glance) and the order thread panel — the interactive moment a demo walkthrough centers on.

**Secondary**: agent activity (merges the selected order's retention decision with the pending-approval queue into one feed, since both are "agent decisions awaiting or past review" — surfaced on demand as the tooltip card, not held on screen permanently) and the storefront audit panel.

## Interaction states

| Feature | Loading | Empty | Error | Success |
|---|---|---|---|---|
| Order thread | "Waiting for the thread…" | "Place a demo order to start a thread." | Red inline message, action stays available to retry | Order + ledger table render |
| Agent activity | Opens on row click / demo order placement, populates via WS/poll | "No agent decisions yet." | N/A | Feed items with status badge + reasoning; × dismisses the card |
| Approval action | Button stays enabled until response | N/A | Silent retry on next poll | Item disappears from the feed |
| Storefront audit | "Crawling…", disabled | "No audit run yet." | Sub-score grid renders as zeros + a plain-language reasoning string naming the real failure (e.g. a 429 from PageSpeed Insights) — never a blank panel | Sub-score grid + fixes + artifact pointer |

## Status badges / chips

Text + color always together (never color alone): `received`/`pending_approval` → warn, `routed`/`completed` → ok, `failed` → error, `rejected` → neutral. Channel pills (`storefront`/`marketplace`) use the accent family, not semantic color, since channel is identity, not state.

## Accessibility

Real `<button>` elements, `disabled` attribute (not just visual dimming) while a request is in flight, visible `:focus-visible` outlines on buttons and inputs, status always paired with text.

## Responsive scope

**Desktop/laptop only (1280px+)** remains the primary target — same reasoning as before (a recorded demo GIF and a live interview screen-share are both desktop contexts). The KPI grid collapses to 2 columns below 860px as a courtesy, not a design goal.
