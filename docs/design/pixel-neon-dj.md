# Pixel Neon DJ — Spinroom design system

The room is a pixel-art nightclub stage: chibi DJs behind a booth, a yellow LED marquee showing the track, neon lights, and the crowd seen from behind. The pixel scene is the show; the player and the music queue are Spotify's.

All built-in art is original and generated in code by `tools/art` (`pnpm art`). Nothing is traced from Turntable.fm, the reference image, or any other product. The laptop lids carry only the Spinroom record mark.

## Canvas and scaling

- Native art resolution **480 × 270**. The stage scales by a whole number (4× at 1920 px wide) with `image-rendering: pixelated`. Below 480 px wide it scales down proportionally.
- No smoothing, gradients or blur. Tonal steps use ordered 2 × 2 dithering or stepped alpha (spotlight beams).
- Animate only `transform` and `opacity`. Pause all scene animation when the tab is hidden. `prefers-reduced-motion` freezes beams, bars, LED strips, avatars and the crowd.
- No strobe: nothing flashes more than 3 times per second.

## Layers, back to front

| Layer                 | Asset                                                          | Driven by                                                                                                               |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Back wall and truss   | `back.webp` (brick, truss, 5 spotlight cans, neon record sign) | Static                                                                                                                  |
| Spotlight beams       | `beam-{violet,cyan,magenta,amber}.webp`                        | Slow CSS sweep; the active DJ's spotlight brightens                                                                     |
| Speaker stacks        | `speakers.webp` + `led.webp` strips                            | LED strips pulse on a synthetic beat loop                                                                               |
| Equalizer bars        | DOM bars                                                       | Synthetic loop (web apps get no access to Spotify's audio)                                                              |
| DJs and laptops       | Avatar sheets + `laptop.webp`                                  | Booth slots; each DJ plays the `dj` animation; name label in slot color                                                 |
| Booth and LED marquee | `booth.webp` + DOM text                                        | Live Spotify metadata, "Artist – Title" in amber VT323; elapsed bottom-left, remaining bottom-right; long titles scroll |
| Dance floor and crowd | `floor.webp` + `crowd.png` / `crowd-mask.png`                  | One figure per present member, tinted with their color; hands up on Hype, turned away on Skip                           |

Slot geometry (native px): booth `x 128–352, y 148–214`; marquee `x 150–330, y 168–198`; DJ centers `x 176, 240, 304`; spotlights `x 48, 144, 240, 336, 432`; floor from `y 214`.

### Crowd and privacy

Individual votes are private to moderators (FR-V6), so crowd reactions are drawn from the aggregate tally: for each spin, a seeded shuffle picks which figures raise hands or turn away in proportion to the Hype and Skip counts. Your own figure always shows your own vote.

### Crowd tinting

`crowd.png` holds hair, skin and outlines; `crowd-mask.png` holds the clothing pixels. The web app stacks a `background-color: <member color>` element masked by `crowd-mask.png` over the base sprite, so 8 back-view variants × 5 frames cover any member color.

## Avatars

- Runtime sheets use **96 × 104** cells; rows are, in order: `idle, hype, skip, dj, walk, wave, away`.
- Presets are drawn at 24 × 26 and upscaled ×4 (nearest neighbour), so they share the format with imported ChatGPT pets.
- On the stage a DJ renders at 48 × 52 native px; crowd figures render at 32 × 40.
- Imported pets have no back view, so they appear front-facing on the booth, in hover cards and in the member list, never on the floor.

## Tokens

| Token        | Hex     | Use                              |
| ------------ | ------- | -------------------------------- |
| `--night`    | #0B1026 | Page and scene background        |
| `--indigo`   | #1A1440 | Panels, booth shadow             |
| `--violet`   | #5B2DFF | Skyline and accent               |
| `--magenta`  | #FF2BD6 | Neon accent, slot 2              |
| `--pink`     | #FF4FA3 | Hype highlights                  |
| `--cyan`     | #3DE2FF | Neon accent, slot 1, focus rings |
| `--purple`   | #7A4DFF | Secondary accent                 |
| `--amber`    | #FFB000 | Marquee text, slot 3             |
| `--yellow`   | #FFD24A | Marquee highlights               |
| `--booth`    | #2A3142 | Booth body, cards                |
| `--charcoal` | #1C2230 | Crowd, floor, inputs             |

Booth slot neon colors: cyan, magenta, amber, shared by each slot's spotlight and name label.

Type: **Pixelify Sans** (names, headings) and **VT323** (marquee), both under the SIL Open Font License and self-hosted. Panel body text uses the system sans for readability. All UI text meets WCAG AA contrast against `--night` and `--indigo`.

## Generation prompt (for future hand-painted plates)

> Pixel art, 480×270, side-on view of a small nightclub stage at night. Dark indigo brick back wall (#1A1440 bricks, #120D30 mortar), a metal lighting truss across the top with five spotlight cans, two tall black speaker stacks left and right with vertical neon LED strips, a dark metal DJ booth (#2A3142) in the center with a black LED marquee panel, a reflective charcoal dance floor (#1C2230) with faint neon reflections. Palette limited to #0B1026 #1A1440 #5B2DFF #FF2BD6 #FF4FA3 #3DE2FF #7A4DFF #FFB000 #FFD24A #2A3142 #1C2230. No people, no text, no logos, no gradients, no anti-aliasing, crisp 1-px pixels.

Hand-painted plates must be snapped to the palette, split into the layers above, and exported as WebP at native resolution.

## Spotify

Album art is never pixelated or restyled. It appears unaltered in the Spotify player panel, outside the pixel scene, with Spotify attribution and an "Open in Spotify" link.
