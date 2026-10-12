# UI guidelines

The rules every Ranvier screen follows. The design canvas (Direction B) and the developer handoff are the source of truth for how things look; this file is the source of truth for how we keep the code consistent and precise. If code and canvas disagree, the canvas wins; if the canvas looks wrong, raise it and record the decision under [Deviations](#deviations).

## 1. Working rules

1. **One source of truth for every value.** Colours, type, spacing, radii, motion and widths are defined once, as tokens, and components reference tokens. No hex colour, `rgb()`, or one-off pixel value in a component. Anything the canvas uses that has no token yet (a border colour, a hover tint) gets a named token first.
2. **Token names match the handoff exactly** (`bg`, `surface`, `ink`, `sub`, `line`, `pill`, `primary`, `accent`, `blush`, `deep`, ...). Do not invent synonyms. Web and mobile share the same names and values.
3. **Build components once and reuse them.** A second copy of a header, button, chip or list row is a bug. Variants are props on one component, not forks.
4. **Match the canvas to the pixel, then verify.** Implement against the artboard, not from memory. Before a screen is done, compare it with the artboard at 1440 px and 390 px (and at 1200 px and 768 px for web), and fix every difference in size, spacing, weight, colour and alignment. Whole pixels only: fractional sizes make paired elements (such as the Hop squares) render unequal.
5. **No numbers or promises hard-coded in copy.** Fees, caps, limits, chain names and token lists come from the shared packages (`@ranvier/fees`, `@ranvier/chains`) or the API, never typed into a component. If the schedule changes, the UI changes with it.
6. **Real data or an honest placeholder.** Production screens show API data. Sample figures live only in fixtures and Storybook-style previews, and are never presented as live.
7. **Every screen handles every state.** Loading, empty, error, disabled, in progress, success, warning and blocked, as specified under [States](#states). A screen with only a happy path is not finished.
8. **Accessibility is part of done**, not a later pass (see [Accessibility](#accessibility)).
9. **Strings are i18n-ready from the first commit.** User-visible text lives in message files keyed by id; English at launch.
10. **Record deviations.** Any intentional difference from the canvas is written down below with the reason.

## 2. Tokens

### Colour

| Token           | Hex                      | Use                                                |
| --------------- | ------------------------ | -------------------------------------------------- |
| `bg`            | `#F7F4F2`                | Page background                                    |
| `surface`       | `#FFFFFF`                | Panels, cards, modals                              |
| `ink`           | `#1C1011`                | Primary text, icons                                |
| `sub`           | `#6E5F61`                | Secondary text, labels, USD values                 |
| `line`          | `#EFE8E5`                | Dividers, hairlines                                |
| `pill`          | `#EDE6E2`                | Header pills, chips, quiet buttons                 |
| `primary`       | `#3B1519`                | Primary buttons, selected chips, active mobile nav |
| `accent`        | `#9B2C35`                | Logo nodes, badges, bullets, focus of attention    |
| `blush`         | `#F2B8A6`                | Accent on dark surfaces, links on oxblood          |
| `deep`          | `#3B1519`                | Dark bands                                         |
| `deep-muted`    | `#D2B3B5`                | Body text on `deep`                                |
| `deep-muted2`   | `#A87A7E`                | Secondary text on `deep`, 24 px and larger only    |
| `deep-tile`     | `#552329`                | Inputs and dividers on `deep`                      |
| `scrim`         | `rgba(28, 16, 17, 0.36)` | Modal backdrop                                     |
| `border-strong` | `#E3D7D2`                | Secondary button border, route connectors          |
| `switch-off`    | `#D9CFCA`                | Switch track, off                                  |
| `row-hover`     | `#FBF9F8`                | List row hover                                     |

Status colours appear only in chips and change rows, always as text on a tint, and always with a word or sign (colour never carries meaning alone):

| Status                       | Text      | Tint      |
| ---------------------------- | --------- | --------- |
| Success, positive change     | `#2C5A35` | `#E7F0E6` |
| Warning, needs attention     | `#7A5200` | `#FBF0DA` |
| Danger, in progress, blocked | `#8E2730` | `#F8E6E4` |
| Neutral, open                | `#1C1011` | `#EDE6E2` |

### Typography

Inter everywhere, as the variable font with the optical-size axis (opsz 14 to 32, weights 300 to 800).

| Style        | Size / weight                 | Tracking | Use                          |
| ------------ | ----------------------------- | -------- | ---------------------------- |
| Display      | 48 px / 700, line height 1.04 | -0.05em  | Swap page title              |
| H1           | 40 px / 700                   | -0.045em | Page titles                  |
| H2           | 32 px / 700                   | -0.035em | Section titles, dark bands   |
| Proof figure | 44 px / 700                   | -0.045em | Large statistics             |
| Amount       | 34 px / 400 (mobile 30 px)    | -0.02em  | Swap amounts and token names |
| Title S      | 17 to 22 px / 600             | -0.02em  | Card and modal titles        |
| Body         | 15 px / 400                   | 0        | Default text                 |
| Small        | 13 to 14 px / 400 to 500      | 0        | Labels, captions, chips      |

Numbers use the `num` style: `font-variant-numeric: tabular-nums`, font features `tnum` and `ss01`, tracking -0.02em. Addresses use `tnum` plus `zero` (slashed zero).

### Spacing, radii, elevation

- Spacing runs on a 4 px base: 4, 6, 8, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 88, 120.
- Radii have two values: **containers** (panels, cards, modals, tables) are square, 0 px; **everything you press** is a full pill, 999 px. Exceptions: app icon corners and token or wallet avatars (round).
- No drop shadows. Separation comes from surface colour and 1 px `line` hairlines.

## 3. Layout

Web screens are designed at 1440 px and are fluid; mobile screens at 390 × 844.

| Element                                          | Rule                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Swap panel                                       | Max 640 px, centred; 20 px page padding each side                                      |
| Content pages (Review, Activity, Account)        | Max 1040 to 1120 px, centred                                                           |
| Narrow flows (Progress, Complete, Pay a request) | Max 560 to 720 px                                                                      |
| Dark bands and footer                            | Full bleed; content max 1440 px with 40 px side padding, 12-column grid, 24 px gutters |
| Two-pane screens                                 | Flex row that wraps: main `flex: 999 1 560px`, side `flex: 1 1 320px`                  |
| Modals                                           | Max 520 to 640 px, top-aligned 72 to 96 px from the top, over the scrim                |

The web header is one line, always: logo left, text nav centred, controls right; nothing wraps and every control is 44 px tall. Below about 1200 px the nav collapses into the "more" menu.

Mobile has no fake status bar. Header 68 px. The bottom nav is a floating white pill with a 1 px `line` border, centred 24 px above the bottom edge, 48 px items, the active item expanded to icon plus label in `primary`. Primary actions on flow screens dock above the nav.

## 4. Logo

The lowercase word "ranvier" in Inter 700 at -0.055em tracking, followed by the Hop mark: two equal squares stepping up and to the right. Geometry in multiples of the wordmark font size (`fs`):

- Square side: 0.15 `fs` at 60 px and above; 0.19 `fs` below 60 px.
- Gap between squares: 0.04 `fs` at 60 px and above; 0.055 `fs` below, minimum 1 px.
- Lower-left square and upper-right square, offset diagonally by one square plus one gap.
- The upper square's top aligns with the x-height; the lower square floats about 0.2 `fs` above the baseline.
- Space from the "r": 0.09 `fs`.
- Every square, gap and offset snaps to whole pixels.

| Context       | Wordmark | Square | Gap  | Mark box |
| ------------- | -------- | ------ | ---- | -------- |
| Web header    | 32 px    | 6 px   | 2 px | 14 px    |
| Mobile header | 29 px    | 6 px   | 2 px | 14 px    |
| Payment card  | 22 px    | 4 px   | 1 px | 9 px     |
| "Secured by"  | 15 px    | 3 px   | 1 px | 7 px     |

Wordmark in `ink` with nodes in `accent` on light surfaces; wordmark white with nodes in `blush` on `deep`. Build the logo once as a component taking a size; do not hand-position it per screen.

## 5. Components

Build once, reuse everywhere:

| Component        | Spec                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web header       | 16 × 20 px padding, one line; logo 32 px; nav items 44 px pills, 16 px text, active = `pill` fill and 500 weight; right group: network pill, wallet pill, bell, more                                                                                           |
| Activity badge   | 18 px pill, `accent` fill, white 11 px / 700 count; hidden at zero                                                                                                                                                                                             |
| Primary button   | Pill, `primary` fill, white 15 to 17 px / 500; heights 44, 52, 56 or 60 px; full width on mobile and in modals                                                                                                                                                 |
| Secondary button | Pill, 1 px `border-strong` border, transparent, `ink` text; ghost variant has no border                                                                                                                                                                        |
| Chip             | 32 to 40 px pill, `pill` fill, 13 to 14 px / 500; selected = `primary` fill, white text                                                                                                                                                                        |
| Swap panel       | `surface`, square, two 24 px-padded rows split by a `line` hairline; label 14 px `sub`; amount 34 px / 400, token name 34 px `sub`, 32 px token icon and chevron; USD value 15 px `sub`, right-aligned; flip button 40 px white circle centred on the hairline |
| Token avatar     | Circle in the token colour; chain badge 16 px bottom-right with a 2 px white ring; 28 to 52 px                                                                                                                                                                 |
| Wallet avatar    | 30 px circle in four quadrants (`primary`, `blush`, `blush`, `accent`), generated from the address                                                                                                                                                             |
| Switch           | 52 × 32 px track, 24 px white knob; on = `primary`, off = `switch-off` (mobile 44 × 28)                                                                                                                                                                        |
| List row         | 56 to 76 px, 1 px `line` divider, hover `row-hover`; leading avatar, two-line text, trailing value or chip                                                                                                                                                     |
| Status chip      | 3 to 4 px × 10 px pill, 12 px / 600, status text on tint                                                                                                                                                                                                       |
| Modal            | `surface`, square; header with 22 px / 600 title and 44 px close; scrim behind; bottom sheet on mobile (top 56 px, 4 px grab handle)                                                                                                                           |
| Route steps      | 10 px square `accent` node per hop, 1 px `border-strong` connector, title, provider and output                                                                                                                                                                 |

## 6. States

Interaction is quiet and fast: colour and opacity change in 150 ms ease. No shadows, scaling or bounce.

| State                | Treatment                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hover, nav and ghost | `rgba(0, 0, 0, 0.05)` fill (0.04 on rows and the rate line)                                                 |
| Hover, primary       | Opacity 0.88                                                                                                |
| Hover, pill controls | `brightness(0.95)`                                                                                          |
| Focus visible        | 2 px outline in `currentColor`, 2 px offset; inputs show a 1.5 px inset `primary` ring on the field instead |
| Selected             | `primary` fill, white text (chips, segmented controls); 1.5 px `primary` border on option cards             |
| Disabled             | Opacity 0.4 to 0.55, no pointer events, `cursor: not-allowed`                                               |
| In progress          | Pulsing outline node (1.2 s ease-in-out, opacity 1 to 0.35); 4 px progress bar in `primary` on `line`       |
| Success              | `primary` filled node with a white check; success chip for positive slippage                                |
| Warning              | Warning tint panel with a plain-English reason and a single fix action                                      |
| Blocked              | Danger badge on the token avatar, reasons list with square bullets, no override path                        |

Motion exists in three places only: the pulsing in-progress node, the switch knob (150 ms), and the nudging arrow on mobile slide-to-swap (1.6 s loop). `prefers-reduced-motion` stops all three.

## 7. Accessibility

Target WCAG 2.1 AA. Checked, not assumed:

- Contrast: `sub` is about 6:1 on white and 5.5:1 on `bg`. `deep-muted` passes for body text on `deep`; `deep-muted2` is for 24 px and larger only.
- Colour never carries meaning alone: every status chip has a word, every change has a sign.
- Touch targets are 44 px minimum on web and mobile, including icon buttons, close buttons and the flip button hit area.
- Real buttons, links and inputs. Switches use `role="switch"` with `aria-checked`; option groups use `radiogroup`; modals use `dialog` (`alertdialog` for a blocked token).
- Icon-only controls carry `aria-label`; decorative icons and the logo nodes are `aria-hidden`.
- Progress bars expose `aria-valuenow`; the Activity badge is part of its link label ("Activity, 1 swap in progress").
- Everything works with the keyboard alone, with visible focus, and in the order it reads.

## 8. Content rules

- Swap screens show **USD only**. Local currency appears only in the buy and sell (ramp) flow, with the sign beside the code (₦ NGN).
- Fees are always itemised before signing, in this order: Ranvier fee, network gas, bridge fee, liquidity provider fees, price impact, then a total. The Ranvier fee is the exact amount the signed quote carries.
- The fee shown for a wrap or unwrap is "Free"; the first-swap waiver is shown as its own line when it applies.
- Copy is short and plain: sentence case, no em dashes, no exclamation marks, numbers as digits. Risk and error text says what happened and what to do ("You could buy but never sell").
- Promises in copy must stay true: positive slippage goes to the user, MEV protection is on, every swap is simulated before signing, Ranvier never holds funds. Do not add a promise the system does not keep.

## 9. Verification

A screen is done when all of these hold:

1. Side by side with its canvas artboard at 1440 / 1200 / 768 / 390 px there are no visible differences in size, spacing, weight, colour or alignment.
2. A grep for hex colours and raw pixel values in component files finds nothing outside the token definitions (checked in CI).
3. A Playwright visual test for the screen exists, at 1440 px and 390 px, for the default and the main error and empty states.
4. An automated accessibility scan (axe) passes, and the keyboard path has been walked by hand.
5. Every string comes from the message files, and every number from the API or shared packages.

## Deviations

Intentional differences from the canvas or handoff, with the reason. Empty means none.

| Item       | Canvas | Code | Reason |
| ---------- | ------ | ---- | ------ |
| (none yet) |        |      |        |

## Known gaps to fix before the first screen ships

The initial web scaffold predates these rules and must be brought in line first:

- Token names in `apps/web/src/app/globals.css` (`canvas`, `muted`, `chip`, `brand`, `brand-deep`) do not match the handoff names above; add the missing tokens (`line`, `border-strong`, `switch-off`, `row-hover`, status colours, `deep-*`, `scrim`).
- The swap panel is 480 px wide (spec: 640 px) and its amounts are 30 px (spec: 34 px).
- The fee line in the swap panel is typed copy; it must be derived from `@ranvier/fees`.
- Inter is loaded without the optical-size axis; switch to the variable font that includes `opsz`.
- The `num` style (tabular numbers, `ss01`) is not applied to amounts and USD values yet.
