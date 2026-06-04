---

version: alpha

name: Falcon Footer — Deploy Info Component

description: >

  Footer component for Falcon Dashboard.

  Renders deployment metadata from _DOTENVRTDB_RUNNER_* environment variables

  as a compact sticky bar with an expandable env variable panel (modal).

  All design tokens, typography, colour, and spacing rules are inherited from DESIGN.md.

  This file extends — never overrides — the base design system.



# ── Footer component tokens ──────────────────────────────────────────────────

components:

  footer:

    backgroundColor: "{colors.surface-body}"

    height:          "40px"

    # border-top: 1px solid {colors.border}

    # padding: 0 28px (desktop) → 0 16px (mobile)

    # z-index: 50 (below topbar 100, above content 1)

    # position: sticky; bottom: 0

    # display: flex; align-items: center; justify-content: space-between

    # overflow: hidden



  footer-chip:

    # One key:value pair in the deploy info row

    # display: inline-flex; align-items: center; gap: 3px

    # flex-shrink: 0



  footer-chip-label:

    textColor:  "{colors.muted}"

    typography: "{typography.label-caps}"

    # font-size: 0.625rem; font-weight: 700; text-transform: uppercase

    # letter-spacing: 0.08em; margin-right: 2px



  footer-chip-value:

    textColor:  "{colors.text}"

    typography: "{typography.caption}"

    # font-size: 0.75rem; font-weight: 400

    # max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap



  footer-chip-separator:

    # width: 1px; height: 12px; background: {colors.border}; margin: 0 12px

    # flex-shrink: 0



  footer-env-button:

    textColor:  "{colors.primary}"

    typography: "{typography.caption}"

    # font-weight: 500; font-size: 0.75rem

    # display: inline-flex; align-items: center; gap: 4px; cursor: pointer

    # background: none; border: none; padding: 4px 8px; border-radius: {rounded.sm}

    # hover: background {colors.primary-light}; transition: background 0.15s

    # ChevronDown icon 12px (rotates 180deg when panel is open)

    # min-height: 44px on mobile (touch target)



  footer-env-modal-row:

    # One variable row inside the env panel

    textColor:  "{colors.text}"

    typography: "{typography.body-sm}"

    # padding: 8px 16px; border-bottom: 1px solid {colors.border}

    # display: grid; grid-template-columns: 42% 58%

    # last row: no border-bottom



  footer-env-key:

    textColor:  "{colors.muted}"

    typography: "{typography.body-sm}"

    # font-weight: 500; font-size: 0.8125rem

    # word-break: break-all; padding-right: 12px



  footer-env-value-plain:

    textColor:  "{colors.text}"

    typography: "{typography.body-sm}"

    # word-break: break-all



  footer-env-value-link:

    textColor:  "{colors.primary}"

    typography: "{typography.body-sm}"

    # cursor: pointer; display: inline-flex; align-items: center; gap: 4px

    # hover: text-decoration: underline

    # ExternalLink icon 12px appended; color: {colors.primary}

    # word-break: break-all



---



## Overview


The footer is a **40 px sticky bar** anchored to the bottom of the viewport. It has two responsibilities:

1. **Deploy Info Row** — always-visible compact summary of the five most important `_DOTENVRTDB_RUNNER_*` fields (Org, Repo, Commit, Date, Host).

2. **Env Panel Trigger** — a small button that opens a **modal** listing every `_DOTENVRTDB_RUNNER_*` variable with clickable values where the value is a URL or hostname.

The footer must never block page content. On pages with fixed-height content areas, add `padding-bottom: 40px` to the scroll container.

---

## Footer Anatomy

```
Desktop (≥ 1024px)
┌──────────────────────────────────────────────────────────────────────────────┐
│  ORG o25160501-zn │ REPO odeploynamemanager │ COMMIT bbb90e8 │              │
│  DATE 1.26.0601.1438 │ HOST github                          [⚙ All Env ▾]  │
└──────────────────────────────────────────────────────────────────────────────┘
Height: 40px │ bg: surface-body │ border-top: 1px solid border

Tablet (640–1023px) — single scroll row, button always visible at right
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← ORG o25160501-zn │ COMMIT bbb90e8 │ DATE 1.26.0601.1438 (scrollable) →  │[⚙]│
└──────────────────────────────────────────────────────────────────────────────┘

Mobile (< 640px) — two-line stacked, button top-right
┌────────────────────────────────────┐
│  COMMIT bbb90e8  DATE 1.26.0601.1438          [⚙]│
│  ORG o25160501-zn  HOST github                    │
└────────────────────────────────────────────────────┘
Height: 52px on mobile
```

---

## Deploy Info Bar

### Source Variables

The five fields in the footer bar map **directly** to `_DOTENVRTDB_RUNNER_*` env vars injected at build/deploy time:

| Label | Env Variable | Example value |
|-------|-------------|---------------|
| `ORG` | `_DOTENVRTDB_RUNNER_ORG` | `o25160501-zn` |
| `REPO` | `_DOTENVRTDB_RUNNER_REPO` | `odeploynamemanager` |
| `COMMIT` | `_DOTENVRTDB_RUNNER_COMMIT_SHORT_ID` | `bbb90e8` |
| `DATE` | `_DOTENVRTDB_RUNNER_COMMIT_AT` | `1.26.0601.1438` |
| `HOST` | `_DOTENVRTDB_RUNNER_HOST_TYPE` | `github` |

### Date Format

`_DOTENVRTDB_RUNNER_COMMIT_AT` uses the format **`1.YY.MMDD.HHSS`** where:

```
1.26.0601.1438
│ │  │  │ │ └── SS  = seconds (38)
│ │  │  │ └──── HH  = hour    (14)
│ │  │  └────── DD  = day     (01)
│ │  └────────── MM  = month   (06)
│ └───────────── YY  = year    (26 → 2026)
└─────────────── 1   = version prefix (always "1")
```

**Display rule:** show the raw value as-is (`1.26.0601.1438`). Do not parse or reformat it. If the value is missing, show `—`.

### Chip Layout (desktop)

Chips are laid out in a single `flex` row with `gap: 0` using separator elements between them:

```
[ORG chip] [separator] [REPO chip] [separator] [COMMIT chip] [separator] [DATE chip] [separator] [HOST chip]    [env button]
```

- Chip label uses `footer-chip-label` (label-caps, muted, 0.625rem).
- Chip value uses `footer-chip-value` (caption, text, 0.75rem).
- Separator: `1px × 12px` vertical line, color `{colors.border}`, `margin: 0 12px`.
- If a value is missing or empty, hide that chip AND its adjacent separator.

### Truncation

- `REPO` and `ORG` values: `max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
- Full value is available on `:hover` via the native `title` attribute.
- `COMMIT`: always 7–8 chars, no truncation needed.
- `DATE`: always 15 chars, no truncation.

---

## Env Panel (Modal)

### Trigger Button

A compact text-button labelled **`⚙ All Env`** (or **`⚙`** icon-only on mobile < 480px) sits at the far right of the footer bar. Clicking it opens the Env Modal. State: ChevronDown icon rotates 180° when open.

```
[⚙  All Env  ▾]     ← desktop / tablet
[⚙]                  ← mobile < 480px (icon only, tooltip "All Env Variables")
```

**NEVER use `window.alert()` or `window.confirm()` here or anywhere.** All feedback must go through a modal or toast.

### Modal Specification

Inherits ALL modal rules from DESIGN.md plus:

```
Size:      default (520px wide)
Header:    "Deploy Environment"  ← h4 weight 600
           Sub-title: "_DOTENVRTDB_RUNNER_* variables"  ← caption, muted
           Close button (X, 20px) top-right
Body:      scrollable table of all variables
Footer:    none (read-only panel)
```

Modal body structure:

```
┌──────────────────────────────────────────────────────┐
│ Deploy Environment                              [X]  │
│ _DOTENVRTDB_RUNNER_* variables                       │
├──────────────────────────────────────────────────────┤
│ [Search input — placeholder "Filter variables..."]   │
├──────────────────────────────────────────────────────┤
│ VARIABLE NAME          VALUE                         │
├─────────────────────────┬────────────────────────────┤
│ ACTOR                   │ o25160501-zn                │
│ ARCH                    │ X64                         │
│ BRANCH                  │ main                        │
│ SERVER_URL              │ ↗ https://github.com        │  ← link
│ WORKFLOW_FILE           │ o25160501-zn/odeployn...    │
│ …                       │ …                           │
└─────────────────────────┴────────────────────────────┘
```

**Key column:** strip the `_DOTENVRTDB_RUNNER_` prefix before displaying. Show `ACTOR`, `ARCH`, `COMMIT_AT`, etc. (uppercase, `footer-env-key` style).

**Value column:** plain text or link (see Link Detection below).

**Search/filter:** a single `<input>` at the top of the modal body. On each keystroke, filter rows by substring match on both key (stripped) and value. Case-insensitive. No rows = show "No variables match" in muted caption text centered.

**Sort order:** alphabetical by stripped key name.

---

## Link Detection Algorithm

For every env variable value, apply the following rules **in order**:

### Rule 1 — Explicit URL (has protocol)

If the value starts with `https://` or `http://` → **Link**. Open with `target="_blank" rel="noopener noreferrer"`. Use value as the `href` directly.

```
https://github.com              → link  ✓
http://localhost:3000           → link  ✓
```

### Rule 2 — Bare hostname or hostname+path (no protocol)

If the value matches the pattern `/^[\w][\w\-]*(\.[a-zA-Z]{2,})([\/:][^\s]*)?$/` AND does not contain `@` (to exclude email-like strings) AND does not contain spaces → **Link**. Prepend `https://` before opening.

```
odeploynamemanager.dpdns.org          → https://odeploynamemanager.dpdns.org  ✓
main.odeploynamemanager.dpdns.org     → https://...  ✓
github.com                            → https://github.com  ✓
```

### Rule 3 — GitHub-relative path

If `_DOTENVRTDB_RUNNER_SERVER_URL` is defined AND the value matches `/^[\w\-]+\/[\w\-]+\/.+$/` (org/repo/path pattern) → **Link**. Build href as: `SERVER_URL + "/" + value`. Strip any `@refs/heads/...` suffix before building the URL.

```
_DOTENVRTDB_RUNNER_WORKFLOW_FILE = "o25160501-zn/odeploynamemanager/.github/workflows/deploy.yml@refs/heads/main"
→ SERVER_URL = "https://github.com"
→ href = "https://github.com/o25160501-zn/odeploynamemanager/.github/workflows/deploy.yml"  ✓
```

### Rule 4 — Plain text

Everything else → plain text, `footer-env-value-plain` style.

### Link Rendering

All detected links use `footer-env-value-link`:

```
[ExternalLink icon 12px]  value text
```

- Icon: `ExternalLink` (Lucide / equivalent), 12px, `color: {colors.primary}`, `flex-shrink: 0`, rendered **before** the text.
- Long URLs: `word-break: break-all` so they wrap, never overflow.
- Hover: `text-decoration: underline`.
- **Always** `target="_blank" rel="noopener noreferrer"`.

---

## Responsive Rules

All rules from DESIGN.md Responsive Behaviour section apply. Additional footer-specific rules:

### Desktop (≥ 1024px)

- Single 40px row; all 5 chips + env button visible in one line.
- Content padding matches main area: `0 28px`.

### Tablet (640–1023px)

- Single row; chips scroll horizontally (`overflow-x: auto; -webkit-overflow-scrolling: touch`).
- Env button is **sticky at the right** (use `position: sticky; right: 0; background: inherit` or a gradient fade mask).
- Content padding: `0 20px`.

### Mobile (< 640px)

- Footer height increases to **52px** to accommodate two lines.
- Row 1: `COMMIT` + `DATE` + env button (right-aligned).
- Row 2: `ORG` + `HOST` (truncate long values to 120px).
- `REPO` chip is **hidden** on mobile (accessible in env panel).
- Env button: icon-only at < 480px — 44×44px touch target (use padding).
- Content padding: `0 16px`.

### Env Modal (mobile)

Follows all modal responsive rules from DESIGN.md:

- At < 640px: `width: calc(100vw - 32px)`.
- `max-height: 90vh`; modal body `overflow-y: auto`.
- Table key column narrows to 35% at < 480px; value column 65%.
- All text inside modal: `word-break: break-all; overflow-wrap: anywhere`.

---

## Dark Mode

All colour tokens switch via CSS variables as defined in DESIGN.md Dark Mode section.

Footer-specific notes:

- Footer background: `var(--surface-body)` (picks up `#0b1727` in dark mode automatically).
- Chip separator: `var(--clr-border)`.
- Chip label: `var(--clr-muted)`; chip value: `var(--clr-text)`.
- Env button: always `{colors.primary}` (`#2c7be5`) — unchanged between modes.
- Env modal: inherits standard modal dark mode behaviour from DESIGN.md.

---

## Z-Index & Layering

```
Toasts (1100)
Modal overlay (1000)
Topbar (100)
Footer (50)       ← sits below topbar but above page content
Dropdowns (200)   ← dropdowns open upward from footer if triggered inside it
Content (1)
```

The env modal uses `z-index: 1000` (standard modal). If a dropdown inside the env modal needs to open, it uses `z-index: 1200` (above the modal).

---

## Do's and Don'ts

### ✅ DO

- **Strip `_DOTENVRTDB_RUNNER_` prefix** when displaying key names in the env panel — show `ACTOR` not `_DOTENVRTDB_RUNNER_ACTOR`.
- **Always use `target="_blank" rel="noopener noreferrer"`** on every external link.
- **Show `—`** (em-dash) for any missing or empty variable value. Never show `undefined`, `null`, or an empty cell.
- **Use tooltip (`title` attribute)** for truncated chip values so the full value is accessible on hover.
- **Apply link detection consistently** — run every value through all 4 rules in order.
- **Make the env panel search real-time** — filter on every keystroke, no submit button.
- **Keep the footer visible at all times** — sticky bottom, never overlapped by content.

### ❌ DON'T

- **Don't show the raw `_DOTENVRTDB_RUNNER_` prefix** as a key name in the env panel table.
- **Don't use `window.alert()`** — the env panel is read-only, but if any copy-to-clipboard action is added, use a Toast for feedback.
- **Don't open links in the same tab** — all detected links always open in a new tab.
- **Don't add `https://` to values that already have a protocol** — avoid double-protocol (`https://https://...`).
- **Don't hide the env button on any viewport** — it must always be reachable (icon-only is fine on mobile, but it must exist).
- **Don't show env variables from other prefixes** (e.g. `CLOUDFLARED_*`) in the `_DOTENVRTDB_RUNNER_*` panel unless explicitly specified elsewhere.
- **Don't add borders to the env modal** — shadow only, following DESIGN.md card/modal rules.
- **Don't stack chips vertically on desktop/tablet** — horizontal only; scroll if needed.

---

## Agent Instructions

When implementing the footer component:

 1. **Read DESIGN.md in full before writing any code.** All tokens, shadows, typography, and component rules are defined there. This file is an extension, not a replacement.

 2. Implement all five deploy info chips from the table in the Deploy Info Bar section. Source values from `_DOTENVRTDB_RUNNER_*` env vars — if a var is missing, show `—`.

 3. The date field always uses `_DOTENVRTDB_RUNNER_COMMIT_AT` raw value (format `1.YY.MMDD.HHSS`). Do **not** reformat it.

 4. Strip the `_DOTENVRTDB_RUNNER_` prefix when displaying keys in the env panel.

 5. Apply the **four link detection rules** (in order) to every env value. Never skip a rule. If a link is detected, render it with the `footer-env-value-link` style, ExternalLink icon, `target="_blank"`, and `rel="noopener noreferrer"`.

 6. Env panel **must** be a modal (inheriting from DESIGN.md modal spec), **not** a dropdown or popover. This ensures it is accessible and scrollable on all screen sizes.

 7. Implement the search/filter input inside the modal body. Filter is real-time, case-insensitive, matches on stripped key name and value simultaneously.

 8. **Never use `window.alert()`, `window.confirm()`, or `window.prompt()`** anywhere in this component.

 9. Apply all responsive rules: 40px desktop/tablet height, 52px mobile height, chip scroll on tablet, two-row layout on mobile, icon-only env button at < 480px.

10. Apply dark mode via CSS variables as specified in DESIGN.md. The footer background must reference `var(--surface-body)`, not a hardcoded hex.

11. Validate all links open with `target="_blank" rel="noopener noreferrer"`. Never open external links in the same tab.

12. **Post-generation responsive audit (REQUIRED):** Simulate at 375px, 768px, and 1280px. Confirm: (a) no horizontal scroll on footer bar (tablet: scroll inside the chips container only), (b) env button always visible, (c) env modal fully scrollable and text unclipped, (d) all links are clickable. Fix any issues before presenting.
