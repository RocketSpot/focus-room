# Bundled fonts (local-first — no CDN at runtime)

The Focus Room serves every font off the room's own machine. `fonts.css`
declares the `@font-face` faces; drop the actual files into `files/` here.

## Required files → `assets/fonts/files/`

| Family | File | Source / licence |
|---|---|---|
| PP Neue Montreal | `PPNeueMontreal-Regular.woff2` | Pangram Pangram — **licensed**, supply your file |
| PP Neue Montreal | `PPNeueMontreal-Medium.woff2` | Pangram Pangram — **licensed** |
| Inter | `Inter-roman.var.woff2` (or `Inter-Regular.woff2`) | rsms.me/inter — OFL |
| IBM Plex Mono | `IBMPlexMono-Regular.woff2` | IBM — OFL |
| IBM Plex Mono | `IBMPlexMono-Medium.woff2` | IBM — OFL |
| IBM Plex Mono | `IBMPlexMono-SemiBold.woff2` | IBM — OFL |

Inter and IBM Plex Mono are open-licensed (OFL) and should be committed so the
build is fully offline. PP Neue Montreal is paid — keep the licensed `.woff2`
files with the build but out of any public mirror.

Until the files are present the type stacks fall back to the system grotesk /
mono, so the app still builds and runs; it just isn't pixel-in-brand yet. This
is wired up in **Phase 6 (brand QA)**.

## Why bundled, not `@import` from Google

`tokens.css` and `_ds/.../colors_and_type.css` originally `@import`ed Google
Fonts. Both CDN imports are now disabled and replaced by this local sheet — see
the master prompt's change #3 and the consumer-app feedback about slow CDN loads.
