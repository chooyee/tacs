# 03 · UI / UX specification

The prototype [`tacs-prototype.html`](../tacs-prototype.html) is the **visual
and interaction reference**. Match its layout and behaviour. Where the
prototype and this document disagree, this document wins. Where the prototype
shows mock-only items (the "Mock AI" badge, "Try with a sample paper PDF"),
leave them out.

## 1. Design system

### 1.1 Basecoat UI + Tailwind

- Use **[Basecoat UI](https://basecoatui.com)**: shadcn/ui components written
  as plain HTML + CSS classes, which works with EJS and vanilla JS.
- Install with npm (`basecoat-css`) and build CSS with the **Tailwind CLI**
  (no bundler). See 10 · §3.
- Use Basecoat's **theme variables** (`--background`, `--foreground`,
  `--primary`, `--muted`, `--destructive`, `--border`, `--radius`, …). Do not
  hard-code colours in templates.
- Status colours are the only additions, defined once in `src/styles/app.css`:

| Token | Use | Light | Dark |
|-------|-----|-------|------|
| `--ok` / `--ok-soft` | Complies, Ready, Yes | `#17794a` / `#e1f3e9` | `#4cc38a` / `#12301f` |
| `--warn` / `--warn-soft` | Partially, "second look" | `#a05f00` / `#fcf0da` | `#e5a54b` / `#38290f` |
| `--bad` / `--bad-soft` | Does not comply, No, gaps, MANDATORY tag | `#c2352a` / `#fbe6e4` | `#ff7b72` / `#3a1714` |

- **Dark mode**: follow the OS setting, with a manual toggle in the top bar
  (stored in `localStorage`, key `psc.theme`).

### 1.2 Component mapping (prototype → Basecoat)

| Prototype element | Basecoat / HTML | Notes |
|-------------------|-----------------|-------|
| Buttons (`.btn`, `.primary`, `.sm`, `.danger`) | `btn`, `btn-primary`, `btn-sm`, `btn-destructive`, `btn-ghost`, `btn-icon` | Icon-only buttons need `aria-label`. |
| Cards / tiles | `card` | Clickable tiles are real `<a>` elements (paper / type links), not `div`s. |
| Pills, tags | `badge` + variants | Readiness, verdicts, MANDATORY, type tag. |
| Modals (new paper, compare, reference viewer, edit standard, edit reference, new type) | Basecoat **Dialog** (native `<dialog>`) | Esc closes; focus returns to the trigger. |
| Toasts (incl. **Undo**) | Basecoat **Toast** | 2.2 s normally, 6 s with Undo. |
| Yes / No / N/A | Button group of 3 `btn`s with `aria-pressed` | Pressed colours: Yes = ok, No = bad, N/A = muted. |
| Filters | Button group with `aria-pressed` | Count shown inside each button. |
| Inputs / textarea / select | `input`, `textarea`, `select`, `label` | Every input has a visible or `aria` label. |
| Progress bars | `<progress>` or `div` with `role="progressbar"` | Green when 100 %. |
| Chat panel | Custom `aside` styled with Basecoat tokens | Not a dialog: the page stays usable while it is open. |
| Mode switch | Basecoat **Tabs** styling, or a toggle group of links | Shown to admins only. |

## 2. Global layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ✓ Paper Standards Check        [Solution Architect | Admin]  ◐  (DT)▾│ ← sticky top bar
├──────────────────────────────────────────────────────────────────────┤
│                         page content (max 1240 px)                    │
└──────────────────────────────────────────────────────────────────────┘
```

- **Top bar** (sticky): logo + app name (link to the current mode's home),
  mode switch (admins only), theme toggle, user menu (avatar initials → name,
  email, roles, **Sign out**).
- Content max width 1240 px, side gutter 16 px, **no horizontal scrolling** at
  any width ≥ 320 px.
- Breakpoints: **≥ 1100 px** desktop (two columns; chat docks and pushes
  content), **720–1099 px** tablet (side panel moves under the form; chat
  overlays), **< 720 px** mobile (chips show letter + count only; chat is full
  screen).

## 3. Screens

### 3.1 Papers home (`/papers`, `/papers?tab=all`)

- Tabs **My papers** | **All papers** (Basecoat Tabs, as links so the URL is shareable).
- *All papers*: search input + paper-type select above the grid; cards also
  show "by <owner>"; pagination at the bottom (FR-PAP-07).

- Heading "My papers" + subtitle "Check your Solution Lab paper against the
  standards for its type before you present it." + **New paper** (primary).
- Grid of paper cards (auto-fill, min 290 px) — content per FR-PAP-01 — and a
  dashed **New paper** card at the end.
- Empty state (FR-PAP-06).
- **New paper dialog**: title input, then paper type as **radio cards**
  (keyboard: arrow keys move between options; the selected card is
  highlighted).

### 3.2 Paper page (`/papers/:id`)

```
← My papers
[Paper title (inline edit)]                      [SaaS standards] [3 things to fix] [Delete]
[Vendor / solution (inline edit)]
┌ sticky section bar ─────────────────────────────────────────────────────────┐
│ (A Identity… 8/9) (B Security ✓) (C Data ✓) (D Backup… 4/5)  [All 33|To do 6|…] │
└──────────────────────────────────────────────────────────────────────────────┘
┌ form column ───────────────────────────────┐ ┌ side panel (sticky) ─────────┐
│ legend                                      │ │ Ready for committee / Not    │
│ ┌ A. Identity & Access Management ───────┐  │ │ ready yet + gap buttons      │
│ │ 1  Entra ID / SSO … [MANDATORY]        │  │ ├──────────────────────────────┤
│ │    (📜 Policy · Identity & Access…)    │  │ │ Progress                     │
│ │    [remark ……………………………]  [Yes|No|N/A]│  │ ├──────────────────────────────┤
│ │    ✦ Complies · page 3 — … [Compare]   │  │ │ ✦ AI paper check (summary)   │
│ └────────────────────────────────────────┘  │ ├──────────────────────────────┤
│ ┌ B. … ┐                                    │ │ References for SaaS          │
└─────────────────────────────────────────────┘ └──────────────────────────────┘
                                                        [✦ AI paper checker ·2]  ← floating button
```

Behaviour details:

- **Section bar** sticks under the top bar. The app sets `--top-bar-h` and
  `--section-bar-h` CSS variables from JavaScript, so sticky offsets and
  `scroll-margin-top` work at every width.
- **Jump** (chip click, gap click, "Go to #N"): smooth scroll to the row,
  centre it, then **flash** it (1.4 s highlight). Disable the animation when
  `prefers-reduced-motion` is set.
- **AI line colours**: Complies = ok-soft, Partially = warn-soft, Does not
  comply = bad-soft, Not found = muted.
- **Saving feedback**: a small status next to each remark ("Saving…",
  "Saved", "Not saved – retry"). Answer buttons update optimistically and
  roll back with a toast if the API call fails.
- **Side panel** order: readiness card (with the optional AI tip, FR-RDY-05) →
  progress → AI check summary → references list.

### 3.2b Read-only paper view (non-owner)

- Banner at the top (Basecoat Alert, info): "You're viewing <owner>'s paper — read-only."
- Title and vendor are plain text. Each standard shows the answer as a
  badge (Yes / No / N/A / Not answered) and the remark as text — no buttons
  or inputs.
- The section bar, filters, readiness card, AI lines, Compare dialog and
  references work as normal.
- The AI checker opens in **history mode**: no 📎, no input box, no quick
  actions that change data, and no Apply / Keep / Fill buttons.

### 3.3 AI paper checker (chat panel)

- **Header**: ✦ avatar, "AI paper checker", subtitle "<paper> · <type>
  standards", close (✕).
- **Paper bar**: "📄 file names · N pages · removed in N days" + **Re-check**, or the hint "No
  paper uploaded yet — attach your Solution Lab paper as a PDF. Uploaded PDFs
  and chat are kept for 7 days."
- **Messages**: user messages right-aligned (primary colour), assistant
  messages left-aligned (muted). A typing indicator shows while waiting.
- **Greeting** (always first, not stored): "Hi <first name> 👋 Upload your
  paper as a PDF (📎 or drag & drop). I'll read every page — text, diagrams
  and tables — compare it with the N <type> policies & samples, and tell you
  for each of the M standards whether your paper complies."
- **Progress message**: 4 steps with ✔ / ◌ / · markers and a progress bar
  (FR-AI-03).
- **Compare card**: verdict, "#N", short standard text, two page thumbnails
  side by side (paper page | reference page) with highlight boxes, the
  finding, and buttons (Side by side · Use AI answer · Go to #N).
- **Quick-action chips** above the input (FR-CHAT-02); they scroll
  horizontally.
- **Composer**: 📎 attach, auto-growing textarea (max 120 px), Send.
- **Drag and drop**: dragging files over the panel shows a dashed overlay
  "Drop your paper PDF here".
- Docked width 440 px. On desktop the page content shifts left and the side
  panel hides while the chat is open; the section bar stays visible.
- Esc closes the panel (unless a dialog is open).

### 3.4 Compare side by side dialog

- Title "#N · <standard text>". Verdict + finding.
- Two columns: **Your paper · page N** and **<icon> <type> · <reference
  title>** (page M). Pages render with **pdf.js** into `<canvas>` at a width
  that fits the column. Image references use `<img>`.
- Highlight box: **solid** outline in the verdict colour on the paper page;
  **dashed** blue outline on the reference page. The position comes from the
  AI's `area` (text ≈ top 22–42 %, diagram ≈ 41–71 %, table ≈ 72–92 % of the
  page height) or from its bounding box if one is returned (see 07 · §4).
- Caption explaining the outlines.
- Footer: Open reference · Go to standard · Use AI answer (primary; hidden if
  it already matches).

### 3.5 Reference viewer dialog

- Left: preview of page 1 (PDF via pdf.js with page next/previous) or the
  image. Right: type badge, note, "Used for" list of standards, **Open
  official document ↗** (only if a link exists).

### 3.6 Admin — Paper types (`/admin/types`)

Cards per FR-ADM-01 + a dashed **New paper type** card. Dialog per FR-ADM-02.

### 3.7 Admin — Paper type editor (`/admin/types/:id`)

- Header: inline name (large) + inline description; **Delete type** (disabled
  with a tooltip if in use).
- Info banner (FR-ADM-10).
- **References** card (FR-ADM-11/12): row actions appear on hover / focus
  (always visible on touch devices).
- **Standards** card: section header rows (letter, inline title, count, ↑ ↓
  🗑), standard rows (number, text, MANDATORY / optional toggle tag, reference
  chips, "✎ Edit links" / "＋ Link a reference" chip, ✎ ↑ ↓ 🗑), and a
  "＋ Add standard" row per section.
- Inline add box hint: "Enter adds it and starts the next one · Esc to finish".

## 4. States every screen must handle

| State | Pattern |
|-------|---------|
| Loading (page) | Server-rendered pages arrive complete. No full-page spinners. |
| Loading (action) | Disable the button + show a spinner inside it. |
| Empty | Short explanation + primary action (see each screen). |
| Saving | Inline "Saving… / Saved" for autosave. Toast for discrete actions. |
| Error (action) | Toast: friendly message + "Reference: <requestId>". Roll back optimistic UI. |
| Error (page) | Error page (`views/pages/error.ejs`) with the message, request ID and a link home. |
| Session expired | API returns 401 → front end shows a dialog "Your session expired — Sign in again" (keep unsaved remark text in `sessionStorage`). |
| No access | 403 page (FR-ACC-03). |
| Not found | 404 page. |

## 5. Accessibility (NFR-A11Y) — WCAG 2.1 AA

1. All functions work with the keyboard. The visible focus ring uses Basecoat's `ring`.
2. Yes / No / N/A, filters and mode switch use `aria-pressed`. Collapsible
   sections use a `button` with `aria-expanded` + `aria-controls`.
3. Dialogs use native `<dialog>` with `showModal()`. They trap focus, close on
   Esc and return focus to the trigger.
4. The chat message list is `aria-live="polite"`. The progress message updates
   politely too.
5. Colour is never the only signal: verdicts have text, red rows have a
   message, and chips show ✓ or a count.
6. Contrast ≥ 4.5:1 for text in both themes. Check the status colours.
7. Respect `prefers-reduced-motion` (no smooth scroll, flash or slide-in).
8. Page `<title>` follows "<Page> · Paper Standards Check".
9. Emoji icons (📜📘🧩🧭✦) are decorative: `aria-hidden="true"`, with the type
   written as text next to them.

## 6. Copy (wording) guidelines

- Plain English, second person ("your paper"), short sentences.
- Button labels are verbs: *Create paper*, *Use AI answer*, *Keep mine*,
  *Re-check*.
- Keep all user-facing strings in `src/views/strings/en.js` (one object) so
  wording changes need no template edits.
