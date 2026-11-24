# Roost — brand and design language

Roost is **your Windows PC, from any browser**: screen, sound, mouse and keyboard, from a phone, a tablet or another
computer. It grew out of [Perch](https://github.com/Just-Rice/perch) (the Mac version, Apache 2.0) and shares its
protocol and security model, but it is its own product with its own look. **Never copy Perch's UI, layout or menus:**
Perch is a teal, single-column, tabbed, "cipher rain" design with a top toolbar in the viewer. Roost is warm,
spatial and Windows-native in feel.

## Words

- The product is **Roost**. The computer being reached is **your PC** (never "Mac"). The person at the keyboard of
  the remote device is "you"; the device they hold is "this device" / "your phone".
- The local settings page is the **Control Center** (not "Setup").
- The viewer's floating controls are **the Dock**; its searchable action list is **the Command palette**; the
  phone/tablet special-keys strip is **the Key deck**; side settings panel is **Tweaks**.
- Tagline: **"Your PC, from anywhere."**
- Tone: short, friendly, plain words, second person. No exclamation marks in errors. Explain the "why" in one line.
- Wire-protocol field names (`macName`, `macSpeakers`, crypto labels such as `"perch bind v1"`) stay as they are:
  they are never shown to anyone, and keeping them lets fixes from Perch be merged. Anything a person can **see**
  says Roost and PC.

## Colour ("Ember")

Defined as CSS custom properties on `:root`, redefined for dark mode under
`@media (prefers-color-scheme: dark)`. Dark is the hero look; light must be equally finished.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FAF7F2` | `#0B0D12` | page |
| `--surface` | `#FFFFFF` | `#151821` | cards, panels |
| `--surface-2` | `#F3EEE6` | `#1C202B` | insets, inputs, hovers |
| `--glass` | `rgba(255,255,255,.72)` | `rgba(21,24,33,.66)` | floating panels (with `backdrop-filter: blur(18px) saturate(140%)`) |
| `--line` | `#E7E0D5` | `#272C38` | borders, dividers |
| `--text` | `#1B1712` | `#F2EEE8` | body text |
| `--muted` | `#6E665C` | `#A39E96` | secondary text |
| `--accent` | `#D9531A` | `#FF7A3D` | ember: primary actions, focus, active |
| `--accent-2` | `#B7790B` | `#FFC15E` | amber: highlights, gradient end |
| `--accent-text` | `#FFFFFF` | `#1A0D05` | text on accent |
| `--accent-soft` | `#FDE7DB` | `#2A1A12` | tinted backgrounds |
| `--good` | `#178A55` | `#4ADE9B` | connected, success |
| `--warn` | `#A86A00` | `#FFC15E` | caution |
| `--bad` | `#C8323F` | `#FF5C6C` | errors, destructive |
| `--ember` | `linear-gradient(135deg, var(--accent), var(--accent-2))` | same | logo, hero, primary button fill |

## Type, shape, motion

- Font stack: `"Segoe UI Variable Text", "Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system,
  Roboto, sans-serif`. Headings use the Display cut with `letter-spacing: -0.01em`, weight 650.
  Mono: `"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace`. No web fonts (CSP and offline use).
- Radius: 20px cards, 12px controls and inputs, 999px pills and the Dock. 1px borders in `--line`, plus a soft
  shadow `0 1px 0 rgba(255,255,255,.04) inset, 0 10px 30px -12px rgba(0,0,0,.35)` in dark.
- Spacing on an 4px grid; generous padding (24px cards on desktop, 16px on phones, 16px page gutter).
- Motion: 160–220ms `cubic-bezier(.2,.8,.2,1)`. Everything respects `prefers-reduced-motion`.
- Background motif: **embers** (`ember.js`): a few slow-drifting warm glows and tiny sparks on a canvas behind the
  page, very subtle, paused when the tab is hidden or reduced motion is on, hidden while viewing a PC.
- Icons: 1.75px stroke, rounded caps and joins, 20px grid (inline SVG).
- The logo is `site/img/icon.svg`: an ember-gradient rounded square with a simple white bird (round body, round head,
  beak, eye) sitting on a dark branch. Keep it that simple: it has to read at 16 pixels in the tray. `app/src/icon.rs`
  draws the same picture for the tray and the .exe.

## Layout signatures (what makes Roost look like Roost)

- **Control Center**: a left sidebar (logo, PC name, sections with icons, connection state at the bottom) and a
  content area of cards. The Home section is a dashboard: a large status "hero" (state ring, PC name, who's
  connected, quick toggles) and a setup checklist shown as a progress stepper until everything is done. On narrow
  screens the sidebar becomes a bottom tab bar.
- **Website**: a hero with the tagline and a stylised phone-showing-a-PC illustration (inline SVG/CSS, no images);
  the connect page lists "Your PCs" as cards in a grid with a coloured monogram each.
- **Viewer**: the PC's screen edge to edge. A floating, draggable **Dock** (pill, glass) that snaps to any edge or
  corner and can shrink to a single glowing orb; the **Command palette** (Ctrl+K style, also a Dock button) lists
  every action and setting, searchable; **Tweaks** is a slide-over panel for quality, sound, mouse and key options;
  the **Key deck** is a scrollable row of chips for phones.
