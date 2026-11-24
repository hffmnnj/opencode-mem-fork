---
version: alpha
name: opencode-mem Memory panel
description: A quiet native side panel in OpenCode Desktop showing the latest memory attached to the current session.
---

# opencode-mem Memory panel

<!-- Agents read this before any UI work. Section order follows the Google Labs DESIGN.md spec. Our extra sections come after it. Lint: bunx @google/design.md lint DESIGN.md -->

## Overview

- **What it is, in one line:** A read-only side panel that shows the exact memory text attached to the current session's latest request.
- **Who uses it, where, how often:** opencode-mem users on OpenCode Desktop, glancing after a prompt to confirm what memory was injected.
- **The one job of the main screen:** Show the latest attachment, or say precisely that there is none.
- **Voice:** plain, precise, quiet; never cute, never explanatory filler.
- **Signature element (the one memorable thing):** The raw injected text itself, selectable, in a wrapping block — no chrome around it.
- **Things true of this product and no competitor:** Shows the exact injected string the server observed; distinguishes attached / none / suppressed / disabled per request; updates live on the server's `changed` event; per-session, per-plugin-location data kept only in memory; never opens itself; never edits, deletes, sends, or persists anything.
- **Platforms and stack:** OpenCode Desktop (SolidJS host); `ctx.ui` native components only (`Button`, `IconButton`, `Tooltip`, `Loader`); icons from the host `IconName` set (`brain`, `copy`, `refresh`); no shadcn, no custom kit, no motion library.
- **Token source of truth:** The host theme. This surface defines no palette, type scale, radius, or spacing of its own; it inherits host tokens and components. This file records behaviors and constraints, not values.
- **Reference images:** none; there is no separate brand direction to hold.

## Colors

This surface adds no color. All text inherits the host foreground; secondary rows (timestamps, the explainer note) render at reduced opacity, never in a literal gray, so both host themes keep their contrast. Status is words ("Memory attached", "No memory context attached"), never a status color. Source of truth is the host theme, mirrored here by rule, not by value.

- **Primary:** none defined; actions use the host `Button` / `IconButton` variants.
- **Neutral and surface:** host panel surface, untouched.
- **On-surface and muted:** host foreground; secondary text inherits it at reduced opacity.
- **Status colors:** none; do not add any.
- **Dark mode:** inherited from the host automatically; verify in screenshots, do not fork values.

## Typography

Host type throughout. The injected attachment renders in the user's monospace face via `ctx.appearance.font("mono")`, because it is machine-generated text the user may copy into a report. Meta rows (status, timestamp) use the host default face at host size. No custom sizes, weights, or line-length rules beyond wrapping.

## Layout

One column inside the host side panel: a meta row (status, timestamp, copy action), the attachment block, one explainer line. The host side region owns width, scrolling, and the narrow-screen view (offered as a `menu` entry). Spacing between rows is one small host step; the attachment block wraps (`pre-wrap`, `break-word`) so long lines never scroll sideways.

## Elevation & Depth

None of its own. No cards, shadows, or glass; the panel is flat host surface. The header action is a host `IconButton`, the panel launcher a host menu item.

## Shapes

Host shapes only. No custom radii anywhere.

## Components

- **Panel tab ("Memory"):** lists only while stored open; closable, never pinned, never auto-opened. Narrow screens get the `menu` view, not a second design.
- **Header action:** a `brain` `IconButton` with tooltip and accessible label that toggles the panel. It shows nothing else; no badge, no count.
- **Panel menu item:** `brain` icon, label "Memory", `opened` while the tab is in the strip. Plain launcher, never primary.
- **Command:** palette entry in the `session` section that opens the panel for the routed session. No default keybind.
- **Copy:** host `IconButton` with tooltip, shown only while non-empty text is on screen.
- **Retry:** host `Button` in the error state only.
- **Loader:** host `Loader` for the initial fetch only, never for live refetches (old content stays up).
- **Never:** Markdown or HTML rendering of the attachment (plain text in `pre`); editing, deleting, sending, or persisting; toasts or notifications; auto-opening on injection.

## Do's and Don'ts

- Do show the exact attachment text, selectable, as plain text (because users compare it against what the model saw).
- Do say "No memory context attached" for empty, with no invented explanation of why nothing matched (because the panel cannot know the reason).
- Do clear content immediately on session switch and on disconnect (because stale memory from another session is worse than none).
- Do keep one explainer line: latest attachment only, not history, not proof of provider receipt (because that is the exact scope users misread).
- Don't add color, badges, counts, toasts, keybinds, or editing affordances (because the surface must stay quiet and read-only).
- Don't render the attachment as Markdown or HTML (because injected text is untrusted content, not markup).
- Don't poll (because the server pushes `changed` events with session and revision).

## Behaviors

- **Loading:** host `Loader` until the first `latest()` resolves; refetches keep old content on screen.
- **Empty:** "No memory context attached" plus the explainer line. A `null` snapshot (nothing observed yet) reads as empty, not as loading.
- **Error:** "Couldn't load the latest memory." plus a Retry button that refetches. A failed refetch keeps the last good snapshot under an inline error with Retry.
- **Offline:** server disconnected clears the content at once and shows "Not connected to the session's server." Reconnect refetches automatically.
- **Permission-denied, first run:** not applicable; the panel needs no permissions and has no setup.
- **Panels and overlays:** the panel never opens itself, on injection or otherwise. The header action toggles; the menu item and command open.
- **Hover, focus, selection:** native host controls only. Attachment text is selectable; keyboard focus is visible per host defaults.
- **Motion:** none. No transitions, no animation, so there is nothing to reduce.

## Surfaces

### Memory panel (side region, all widths)

- **Job:** Show one session's latest attachment and its state.
- **Deviations:** none; the narrow-screen `menu` view renders the same component.

## Decisions

| Date       | Decision                                                                                       | Why                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2026-10-28 | Inherit host tokens and `ctx.ui` components; define no palette or scale (inferred)             | This plugin ships inside the host's Solid/Electron shell, so a second brand would clash with the user's theme |
| 2026-10-28 | Plain-text `pre` for the attachment, never Markdown/HTML (inferred)                            | Injected text is untrusted model input; rendering it as markup would execute its formatting as ours           |
| 2026-10-28 | Event-driven live update with generation-guarded refetch, no polling (inferred)                | `changed` carries session and revision, so polling adds load for no new information                           |
| 2026-10-28 | Retry also recovers a failed subscription startup, not just failed fetches (inferred)          | A synchronously thrown setup must land in the error state with Retry, never crash the panel                   |
| 2026-10-28 | A replaced server client refetches and resubscribes even while connected stays true (inferred) | Client identity is part of the session key, so a restarted server cannot leave the panel on a dead client     |
