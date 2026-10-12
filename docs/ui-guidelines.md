# UI guidelines

The rules every Ranvier screen follows. The design canvas (Direction B) and the developer handoff are the source of truth for how things look; this file is the source of truth for how we keep the code consistent and precise. If code and canvas disagree, the canvas wins; if the canvas looks wrong, raise it and record the decision under [Deviations](#deviations).

## Precedence

When sources disagree, the first rule that applies wins:

1. **Truth and safety.** Fee numbers and promises must match the actual rules (`packages/fees`, ADR 0002, `docs/overview.md`); nothing the system does not do may be claimed; accessibility rules (semantics, 44 px targets, visible focus, contrast) and security rules hold.
2. **Appearance** (sizes, spacing, colours, shapes, layout): the canvas artboards.
3. The developer handoff.
4. These guidelines.
5. Existing code.

Where the canvas beats the handoff or these guidelines, this file is updated to the canvas value so docs and code agree (see the corrections listed under [Deviations](#deviations)). Where rule 1 beats the canvas, rule 1 is followed and the difference is recorded under Deviations.

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
| `on-primary`    | `#FFFFFF`                | Text and icons on `primary`, `accent` and `deep`   |
| `hover`         | `rgba(0, 0, 0, 0.05)`    | Hover fill for nav items and ghost buttons         |
| `hover-row`     | `rgba(0, 0, 0, 0.04)`    | Hover fill for rows and the rate line              |

Network marks (`chain-ethereum #627EEA`, `chain-base #0052FF`, `chain-solana #9945FF`, `chain-bnb #F3BA2F`, `chain-arbitrum #28A0F0`) colour network coins and dots only. In code the status tokens are named `success-text`, `success-tint`, `warning-text`, `warning-tint`, `danger-text`, `danger-tint`, `neutral-text` and `neutral-tint`.

Status colours appear only in chips and change rows, always as text on a tint, and always with a word or sign (colour never carries meaning alone):

| Status                       | Text      | Tint      |
| ---------------------------- | --------- | --------- |
| Success, positive change     | `#2C5A35` | `#E7F0E6` |
| Warning, needs attention     | `#7A5200` | `#FBF0DA` |
| Danger, in progress, blocked | `#8E2730` | `#F8E6E4` |
| Neutral, open                | `#1C1011` | `#EDE6E2` |

### Typography

Inter everywhere, as the variable font with the optical-size axis (opsz 14 to 32, weights 300 to 800). On web it is `@fontsource-variable/inter/opsz.css` (family `Inter Variable`, weights 100 to 900 in one file); a Playwright test checks that the axis changes glyph widths.

| Style        | Size / weight                  | Tracking | Use                                                                                             |
| ------------ | ------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| Display      | 48 px / 700, line height 1.04  | -0.05em  | Marketing and content page titles (not used on the swap screen, whose title is visually hidden) |
| H1           | 40 px / 700                    | -0.045em | Page titles                                                                                     |
| H2           | 32 px / 700                    | -0.035em | Section titles, dark bands                                                                      |
| Proof figure | 44 px / 700                    | -0.045em | Large statistics                                                                                |
| Amount       | 36 px / 400 (mobile app 30 px) | -0.02em  | Swap amounts and token names                                                                    |
| Title S      | 17 to 22 px / 600              | -0.02em  | Card and modal titles                                                                           |
| Lead         | 16 px / 400 to 500             | 0        | Header nav, primary button                                                                      |
| Body         | 15 px / 400                    | 0        | Default text                                                                                    |
| Small        | 13 to 14 px / 400 to 500       | 0        | Labels, captions, chips                                                                         |
| Badge        | 11 px / 700                    | 0        | Activity badge count                                                                            |

In code each style is a token utility: `text-display`, `text-h1`, `text-h2`, `text-proof`, `text-amount`, `text-amount-mobile`, `text-title-s`, `text-lead`, `text-body`, `text-small`, `text-caption`, `text-badge` (size, weight and tracking together).

Numbers use the `num` style: `font-variant-numeric: tabular-nums`, font features `tnum` and `ss01`, tracking -0.02em. Addresses use `tnum` plus `zero` (slashed zero). In code these are the `num` and `addr` utilities; every amount and USD value uses `num`.

### Spacing, radii, elevation

- Spacing runs on a 4 px base: 4, 6, 8, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 88, 120. In code a spacing utility is named by its pixel value (`p-24` is 24 px, `gap-6` is 6 px) and only these steps exist. Values the canvas uses that are off the scale are kept as extra named steps: 5, 7, 10, 18, 22, 26, 30 and 160, plus control sizes (`control` 44, `avatar` 30, `cta` 264, `menu` 240) and the panel width (`max-w-panel` 640).
- Radii have two values: **containers** (panels, cards, modals, tables) are square, 0 px; **everything you press** is a full pill, 999 px. Exceptions: app icon corners, token or wallet avatars (round), and the swap flip button, which the canvas draws as a 44 px square.
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

The web header is one line, always: logo left, text nav centred, controls right; nothing wraps and every control is 44 px tall. It is a three-column grid `minmax(0, 1fr) auto minmax(0, 1fr)` with a 20 px gap and 16 × 20 px padding; nav items have 0 × 14 px padding with a 4 px gap, and the right group has a 6 px gap. Below 1200 px the nav collapses into the "more" menu; below 640 px the network pill shows its coin only and the bell moves into the more menu.

Mobile has no fake status bar. Header 68 px. The bottom nav is a floating white pill with a 1 px `line` border, centred 24 px above the bottom edge, 48 px items, the active item expanded to icon plus label in `primary`. Primary actions on flow screens dock above the nav.

## 4. Logo

The lowercase word "ranvier" in Inter 700 at -0.055em tracking, followed by the Hop mark: two equal squares stepping up and to the right. Geometry in multiples of the wordmark font size (`fs`):

- Square side: 0.15 `fs` at 60 px and above; 0.19 `fs` below 60 px (rounded to whole pixels).
- Gap between squares: 0.04 `fs` at 60 px and above; 0.055 `fs` below, minimum 1 px.
- Lower-left square and upper-right square, offset diagonally by one square plus one gap.
- The upper square's top aligns with the x-height; the lower square floats about 0.2 `fs` above the baseline.
- Space from the "r": 0.09 `fs`.
- Every square, gap and offset snaps to whole pixels.

| Context       | Wordmark | Square | Gap  | Mark box | Lift above baseline | Space from "r" |
| ------------- | -------- | ------ | ---- | -------- | ------------------- | -------------- |
| Web header    | 32 px    | 6 px   | 2 px | 14 px    | 8 px                | 3 px           |
| Mobile header | 29 px    | 6 px   | 2 px | 14 px    | 6 px                | 3 px           |
| Payment card  | 22 px    | 4 px   | 1 px | 9 px     | 6 px                | 2 px           |
| "Secured by"  | 15 px    | 3 px   | 1 px | 7 px     | 3 px                | 2 px           |

The table is checked against the canvas formulas (`logoGeometry` in `apps/web/src/components/logo-geometry.ts`) by unit tests for every reference size. The lift is `round(0.1367 fs + 0.55 fs - box)` and the space from the "r" is `max(2, round(0.09 fs))`.

Wordmark in `ink` with nodes in `accent` on light surfaces; wordmark white with nodes in `blush` on `deep`. Build the logo once as a component taking a size; do not hand-position it per screen.

## 5. Components

Build once, reuse everywhere:

| Component        | Spec                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web header       | Shared component (`Header`). Grid and padding as in [Layout](#3-layout); logo 32 px; nav items 44 px pills, 16 px text, active = `pill` fill and 500 weight; right group: network pill (coin 30 px, or four dots for "All networks"), wallet pill or Connect wallet button, bell, more. Props: active tab, wallet, network, Activity count                                                                                      |
| Activity badge   | 18 px pill, `accent` fill, white 11 px / 700 count; hidden at zero; read as part of the link label ("Activity, 1 swap in progress")                                                                                                                                                                                                                                                                                             |
| Primary button   | Pill, `primary` fill, white 15 to 17 px / 500; heights 44, 52, 56 or 60 px; full width on mobile and in modals. The swap screen's button is 264 × 56 px, 16 px, centred 16 px under the panel                                                                                                                                                                                                                                   |
| Secondary button | Pill, 1 px `border-strong` border, transparent, `ink` text; ghost variant has no border                                                                                                                                                                                                                                                                                                                                         |
| Chip             | 32 to 40 px pill, `pill` fill, 13 to 14 px / 500; selected = `primary` fill, white text                                                                                                                                                                                                                                                                                                                                         |
| Swap panel       | `surface`, square, max 640 px; top row padding 24 24 32, bottom row 32 24 26, split by a 1 px `line` hairline; heading 14 px `sub` ("Pay on {chain}", the chain name a link); amount 36 px / 400 in `num`, token name 36 px `sub`; USD value 15 px, right-aligned (`accent` button on the pay row, `sub` text on the receive row); "Auto" slippage link 13 px. The connected-state screen adds the 32 px token icon and chevron |
| Flip button      | The one square control: 44 × 44 px, `primary` fill, two 7 px `blush` squares, centred on the hairline (top -22 px). A real button labelled "Switch pay and receive"                                                                                                                                                                                                                                                             |
| Token avatar     | Circle in the token colour; chain badge 16 px bottom-right with a 2 px white ring; 28 to 52 px                                                                                                                                                                                                                                                                                                                                  |
| Wallet avatar    | 30 px circle in four quadrants (`primary`, `blush`, `blush`, `accent`), generated from the address                                                                                                                                                                                                                                                                                                                              |
| Switch           | 52 × 32 px track, 24 px white knob; on = `primary`, off = `switch-off` (mobile 44 × 28)                                                                                                                                                                                                                                                                                                                                         |
| List row         | 56 to 76 px, 1 px `line` divider, hover `row-hover`; leading avatar, two-line text, trailing value or chip                                                                                                                                                                                                                                                                                                                      |
| Status chip      | 3 to 4 px × 10 px pill, 12 px / 600, status text on tint                                                                                                                                                                                                                                                                                                                                                                        |
| Modal            | `surface`, square; header with 22 px / 600 title and 44 px close; scrim behind; bottom sheet on mobile (top 56 px, 4 px grab handle)                                                                                                                                                                                                                                                                                            |
| Route steps      | 10 px square `accent` node per hop, 1 px `border-strong` connector, title, provider and output                                                                                                                                                                                                                                                                                                                                  |

## 6. States

Interaction is quiet and fast: colour and opacity change in 150 ms ease. No shadows, scaling or bounce.

| State                | Treatment                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover, nav and ghost | `rgba(0, 0, 0, 0.05)` fill (0.04 on rows and the rate line)                                                                                                                                                                                                                 |
| Hover, primary       | Opacity 0.88                                                                                                                                                                                                                                                                |
| Hover, pill controls | `brightness(0.95)`                                                                                                                                                                                                                                                          |
| Focus visible        | 2 px outline in `currentColor`, 2 px offset; filled `primary` controls use a `primary` outline so it shows on the light page; inputs show a 1.5 px inset `primary` ring on the field instead (the canvas removes the input outline, which accessibility rules do not allow) |
| Selected             | `primary` fill, white text (chips, segmented controls); 1.5 px `primary` border on option cards                                                                                                                                                                             |
| Disabled             | Opacity 0.4 to 0.55, no pointer events, `cursor: not-allowed`                                                                                                                                                                                                               |
| In progress          | Pulsing outline node (1.2 s ease-in-out, opacity 1 to 0.35); 4 px progress bar in `primary` on `line`                                                                                                                                                                       |
| Success              | `primary` filled node with a white check; success chip for positive slippage                                                                                                                                                                                                |
| Warning              | Warning tint panel with a plain-English reason and a single fix action                                                                                                                                                                                                      |
| Blocked              | Danger badge on the token avatar, reasons list with square bullets, no override path                                                                                                                                                                                        |

Motion exists in three places only: the pulsing in-progress node, the switch knob (150 ms), and the nudging arrow on mobile slide-to-swap (1.6 s loop), besides the 150 ms colour fades. `prefers-reduced-motion` stops all of them.

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
2. The token guard passes (see below): no hex colours, colour functions, shadows or pixel literals in component files.
3. Playwright conformance tests for the screen exist, at 1440 px and 390 px (and 1200 and 768 for the header), asserting computed values for the default and the main error and empty states. They assert values, not pixel baselines, because fonts differ between machines.
4. An automated accessibility scan (axe) passes, and the keyboard path has been walked by hand.
5. Every string comes from the message files, and every number from the API or shared packages.

### Token guard

`pnpm guard:tokens` (also a CI step) scans every `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.css` and `.html` file under `apps/web/src` except `src/styles/tokens.css`, after removing comments. It fails on:

- **hex-colour**: any `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` literal (an anchor such as `#main` is fine; one that is all hex digits, such as `#add`, would be flagged).
- **colour-function**: `rgb(`, `rgba(`, `hsl(`, `hsla(`, `hwb(`, `lab(`, `lch(`, `oklab(`, `oklch(`.
- **shadow**: `box-shadow` / `boxShadow`, and the Tailwind `shadow-*`, `drop-shadow-*`, `inset-shadow-*`, `text-shadow-*` and `ring-*` utilities.
- **arbitrary-value**: a Tailwind arbitrary value (`w-[640px]`, `min-[1200px]:flex`, `z-[12]`, `[margin-top:12px]`, `h-[calc(var(--x)+4px)]`) whose content has a length unit, a bare number or a hex colour. Allowed: `var(--token)` on its own, selector variants (`aria-[current=page]:`), and brackets with no literal (`grid-cols-[minmax(0,1fr)_auto]`).
- **inline-style**: a `style` prop or attribute with a length unit, a non-zero number literal, a hex colour, or a quoted colour name other than `var(--...)`, `inherit`, `currentColor`, `transparent` or `none`. Computed values (`fontSize: g.fontSize`) and `0` pass.
- **css-pixel**: a `px` literal in a CSS file other than the token file.

Add the value to `tokens.css` first, then use the token utility. The rules and their fixtures are tested in `apps/web/tests/unit/token-guard.test.ts`.

### Playwright conformance tests

```
pnpm --filter @ranvier/web exec playwright install chromium   # once
pnpm e2e                                                      # builds, starts the production build, runs the tests
```

`apps/web/tests/e2e` holds the geometry and computed-style tests (`swap.spec.ts`) and the axe, keyboard and reduced-motion tests (`a11y.spec.ts`). They run against `next build` plus `next start` on port 3100, in CI after the build. Unit tests (`pnpm --filter @ranvier/web test`) cover the tokens against the colour table above, the logo geometry for every reference size, the message files, the fee copy and the guard.

## Deviations

Intentional differences from the canvas or handoff, with the reason.

| Item                   | Canvas                                      | Code                                                                                                                  | Reason                                                                                            |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Nav collapse           | Header always shows the full nav            | Below 1200 px the nav moves into the more menu (a disclosure button with Escape, outside click and focus return)      | Assumed: the handoff lists it as an open item; the nav does not fit one line at 768 px            |
| More control           | A link to the account page                  | A disclosure button at every width; the account link is inside its panel                                              | It has to host the collapsed nav                                                                  |
| Narrow header          | Not designed at 390 px on web               | Below 640 px the network pill shows its coin only (the name stays in its label) and the bell moves into the more menu | Keeps the header on one line with 44 px controls at 390 px                                        |
| Connect wallet         | A link                                      | A `button`                                                                                                            | It is an action (it will open a connect dialog)                                                   |
| Flip button            | Square                                      | Square                                                                                                                | Kept: the one non-pill pressable, listed in Layout and Components                                 |
| Row padding 26 px      | 26 px bottom padding on the receive row     | Named step `pb-26`                                                                                                    | Canvas value kept for fidelity; owner may normalise to 28                                         |
| Other off-scale values | 5, 7, 10, 18, 22, 30, 160 px                | Named steps                                                                                                           | Canvas values kept for fidelity                                                                   |
| Page min-height        | Main is 900 px tall                         | Not replicated                                                                                                        | The FAQ band and footer that fill it are out of scope here                                        |
| Input focus            | Outline removed                             | 1.5 px inset `primary` ring                                                                                           | Accessibility: focus must stay visible                                                            |
| Primary control focus  | `currentColor` outline (white on `primary`) | `primary` outline                                                                                                     | A white ring is invisible on the light page                                                       |
| Sample data            | USDT, ETH, BNB Chain, 0.4006, $997.12       | ETH on Ethereum to USDC on Base from the chain registry, empty fields (placeholder 0), $0.00                          | Sample figures are not real data and BNB Chain is not in the registry                             |
| Arbitrum colour        | Not drawn                                   | `chain-arbitrum` `#28A0F0`                                                                                            | The registry lists Arbitrum One; the canvas has no colour for it. Owner to confirm                |
| Network letter colour  | Ink on every coin                           | White on Base and Solana                                                                                              | Contrast of 4.5:1 for the letter                                                                  |
| Fee copy               | FAQ: "A 0.2% fee per swap"                  | Not reproduced; fee copy is derived from `FEE_SCHEDULE`                                                               | The schedule has tiers, a stablecoin rate, free wraps and a first-swap waiver (precedence rule 1) |
| Unbuilt routes         | Link to other artboards                     | Links to `/trade`, `/buy`, `/activity`, `/portfolio`, `/account`, `/select-token`, `/settings`                        | Routes arrive with their screens; until then they are not found                                   |
| Wallet avatar          | Quadrants by address                        | Fixed `primary`, `blush`, `blush`, `accent`                                                                           | Address-derived avatar comes with wallet connection                                               |

Corrections made to these guidelines because the canvas is the source for appearance: amount 36 px (was 34), mobile amount 30 px confirmed; flip button is a 44 px square `primary` button (was a 40 px white circle); the swap screen title is visually hidden, so Display is no longer the swap title; swap rows carry their canvas paddings and no token icon or chevron on the signed-out screen; the header grid, gaps and paddings are specified; the logo table gains the lift and space columns (its square, gap and box values were confirmed against the canvas); off-scale spacing values and the extra colour tokens were added.

Out of scope for the first swap screen and left for later changes: the route strip, the rate pill, the "Best of 4 routes" line, the FAQ band and the footer (they need data).
