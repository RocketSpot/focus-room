# Third-party services & optional setup

**None of this is required to run a session.** The Focus Room is local-first: it
runs fully offline with sensible fallbacks. Everything below is an *optional
upgrade* — turn each one on only when you want the real thing instead of the
fallback. Each section says exactly what you get, what happens without it, and
the steps to enable it.

| Service | What it powers | Without it (the fallback) |
|---|---|---|
| **Postmark** | Emails the guest their reading takeaway | Email is written to disk, not sent |
| **Printer** | Prints the physical takeaway card | Card is still saved as a PDF; nothing prints |
| **PP Neue Montreal** | The exact brand display font | Falls back to Space Grotesk (bundled, close) |
| **Room speakers** | Where the brain-state room sound plays | Plays out the PC's default audio device |
| **Apple Developer** | Signed/notarized macOS `.dmg` | Windows `.exe` build is unaffected |

---

## How to set the environment variables

There is no `.env` file loader in this project — the app reads variables straight
from the process environment. Set them **before** launching.

**For a dev run (this PowerShell session only):**

```powershell
$env:POSTMARK_API_KEY = "your-token-here"
$env:FOCUSROOM_EMAIL_FROM = "The Focus Room <room@wear.zone>"
npm run dev
```

**For a packaged install (persist across reboots)** — set them as Windows user
environment variables so the installed `.exe` always sees them:

```powershell
# run once; takes effect in new processes (sign out/in to be safe)
setx POSTMARK_API_KEY "your-token-here"
setx FOCUSROOM_EMAIL_FROM "The Focus Room <room@wear.zone>"
```

> `setx` writes the value permanently but does **not** affect the current shell —
> open a new terminal (or relaunch the app) to pick it up. Don't paste secrets
> into a file that gets committed; keep the token in the environment only.

---

## 1. Postmark — the guest takeaway email

**What it powers:** at the end of a session the app renders the guest's annotated
reading report and emails it to the address they entered, with the line image
attached inline.

**Without it:** the app uses a built-in *dev file provider* — it writes the
email HTML and its attachments into the outputs folder (dev: `data/outputs/`) and
logs `[email:dev] (no POSTMARK_API_KEY) …`. Nothing is actually sent. This is
fine for testing the whole flow without an account.

**Enable it:**

1. Create a Postmark account at <https://postmarkapp.com>.
2. Create (or open) a **Server**, then open its **API Tokens** tab and copy the
   **Server API Token**.
3. Verify the address you'll send *from*: **Sender Signatures → Add** and confirm
   the single address, **or** verify the whole domain (recommended — add
   Postmark's DKIM + Return-Path DNS records for deliverability). The `From`
   address you use must match a verified signature or domain.
4. New Postmark accounts are approval-gated: to send to arbitrary guest
   addresses you may need to request account approval (they review the first
   batch). The free tier allows ~100 emails/month.
5. Set the variables:

   | Variable | Purpose | Default |
   |---|---|---|
   | `POSTMARK_API_KEY` | Server API Token (`POSTMARK_SERVER_TOKEN` also accepted) | — (falls back to dev-file) |
   | `FOCUSROOM_EMAIL_FROM` | The `From` line; must be a **verified** Postmark sender/domain | `The Focus Room <room@wear.zone>` |
   | `FOCUSROOM_CTA_URL` | The button link in the email | `https://wear.zone/roadmap` |

**Notes**
- Messages send on Postmark's default `outbound` transactional stream.
- If a send fails or the machine dies mid-send, the payload is kept as
  `pending-email-<timestamp>.json` in the outputs folder so a guest's report is
  never silently lost — it's deleted only on a confirmed success.
- The send is abort-capped at 10s so a hung API call can never freeze the room.

---

## 2. Printer — the physical takeaway card

**What it powers:** printing the takeaway card to a physical printer at
session end.

**Without it:** the card is **always** rendered to a PDF in the outputs folder.
Physical printing is simply skipped. (This was made opt-in on purpose so a dev
run never fires the developer's personal printer.)

**Enable it:**

1. Set the printer you want as the **Windows default printer**
   (Settings → Bluetooth & devices → Printers & scanners → *your printer* → Set
   as default). The app prints to the OS default.
2. Turn on printing:

   ```powershell
   $env:FOCUSROOM_PRINT = "1"     # or: setx FOCUSROOM_PRINT 1  (persistent)
   ```

With `FOCUSROOM_PRINT` unset or anything other than `1`, nothing prints — the PDF
is your record either way.

---

## 3. PP Neue Montreal — the exact display font

**What it powers:** the brand display typeface used on headings across the TV,
iPad, and printed card.

**Without it:** PP Neue Montreal is a **licensed** font and can't be redistributed
in the repo, so it isn't bundled. The CSS stack falls back to **Space Grotesk**
(which *is* bundled) — visually close, but not the licensed brand face. Inter and
IBM Plex Mono (body + mono) are bundled and always correct.

**Enable it:**

1. Obtain a license for PP Neue Montreal (Pangram Pangram Foundry) and export the
   web format for two weights:
   - `PPNeueMontreal-Regular.woff2`
   - `PPNeueMontreal-Medium.woff2`
2. Drop both files into `assets/fonts/files/`. The `@font-face` rules in
   `assets/fonts/fonts.css` already point at those exact filenames — no code
   change needed.
3. For a packaged build, re-run `npm run build:webroot` so the fonts are staged
   into `build/webroot/`.

---

## 4. Room audio — the brain-state sound

**What it powers:** the room's generative sound, in two scenes that crossfade by
beat — all in one warm key (F major) so every sound belongs to the same music:

- **Menu scene** (idle constellation, welcome, questions, picker, reveal, close):
  a calm "home menu" lobby — a slow loop of warm open chords with a sparse
  felt-piano note every few bars, alive but never thumpy (no percussion).
- **Session scene** (signal check + reading): very calm — one sustained warm
  chord whose *timbre* follows the guest's live signal: it brightens gently as
  they settle in, gets deeper and warmer as they drift, with a slow breathing
  pulse and a soft duck when the notification hits. Changes are smoothed over
  many seconds — nothing sudden ever happens.

It's built the way NextSense's Relax/Focus and Endel actually work: **not a
playlist** but layers whose volumes and brightness follow one heavily-smoothed
EEG scalar, with the palette tuned per the sleep/relaxation-music literature
(diatonic added-tone harmony, no bass detune-beating, short intimate reverb).
Fully generative in Web Audio — **no audio files, no internet, no licensing** —
so it never repeats and always fits the offline, local-first rule. It makes
**no claim** about the guest; it's an aesthetic layer, not a score. UI sounds
ride the same system: a soft tap-plink and screen-transition breath (beginning
and end beats only — never mid-session), a console-style scroll tick as the
reveal slideshow advances, and a warm rising chime when the guest's dot lands
on the constellation.

**How it runs:** a hidden, always-loaded window (`room-audio.html`) hosts the
engine so it never restarts when the TV changes surfaces. It plays out of the
**PC's default audio output**.

**Produced beds (Suno):** two Suno-generated ambient beds are bundled locally —
`assets/audio/lobby.ogg` (the menu scene) and `assets/audio/session.ogg` (the
reading scene). They were generated on the owner's Suno **Pro** account
(commercial rights) and play fully offline. The engine finds each track's steady
mid-section automatically and loops it there, so the fade-in/out never plays;
the adaptive brain-following layers and every UI cue ride on top. **To swap a
bed:** replace the file (same name) with any other track — key of F / D-minor
family and beatless-for-session work best — and restart; loop points are
re-detected. **Remove the files** and the engine falls back to full synthesis.
The unused alternate takes live in `Downloads/` (`Warm Analog Stillness (1).wav`,
`Warm Felt Piano (1).wav`) — convert with
`ffmpeg -i in.wav -c:a libvorbis -q:a 7 out.ogg`.

**Setup:**

1. Set your room speakers (or the TV's audio) as the **Windows default output
   device** (Settings → System → Sound → Output). That's the only required step —
   the sound follows the default device.
2. It's **on by default**. To run silently (e.g. while developing), set
   `FOCUSROOM_NO_AUDIO=1`.

**Per-beat behaviour:** near-silent when the room is idle; gentle during
welcome/setup; **fully reactive during the reading**; warm and resolving under the
reveal; a soft outro at the close.

**Optional upgrade — Suno / produced stems (not required):** if you ever want a
more "produced" bed than the built-in synthesis, you can layer in pre-made loops
(e.g. Suno-generated ambient stems). The right way is *vertical layering*: export
several **tempo-locked, same-key** stems (pad / warm / shimmer / depth), drop them
in as `<audio>`/buffer sources, and drive their **gains** from the same smoothed
scalar the engine already computes — never crossfade whole different tracks (that
causes the jarring cuts adaptive audio is designed to avoid). Mind Suno's
commercial-use licensing if you go this route. The generative engine is the
recommended default because it's offline, free, and never repeats.

---

## 5. Apple Developer — signed macOS build (deferred)

Only relevant when you build the macOS `.dmg` on the Mac Mini; the Windows `.exe`
build needs none of this. A distributable Mac build needs an Apple Developer
account ($99/yr), a *Developer ID Application* certificate, and notarization
credentials (an app-specific password or `notarytool` keychain profile). The
Bluetooth entitlement for the earbuds is also a macOS-signing concern. See
[docs/BUILD.md](BUILD.md) for the packaging specifics when that phase comes up.

---

## Appendix — other environment toggles

These aren't third-party services, just built-in knobs you may want in dev:

| Variable | Effect |
|---|---|
| `FOCUSROOM_DEMO=1` | Opt-in attract-loop: auto-drives a full fake session on repeat in sim (see below) |
| `FOCUSROOM_NO_AUDIO=1` | Silence the generative room sound (no hidden audio window) |
| `FOCUSROOM_SIMULATE=1` | Force simulation mode (same as the `--simulate` flag) |
| `FOCUSROOM_LAN_PORT` | LAN server port for the iPad/TV surfaces (default `4321`) |
| `FOCUSROOM_REVEAL_STEP_MS` | Per-slide dwell time on the reveal (default `60000`) |
| `FOCUSROOM_PLATEAU_FALLBACK_MS` | Fire the interruption anyway if no EEG plateau is detected (default `75000`) |
| `FOCUSROOM_BASELINE_MS` | Length of the resting baseline capture (default `15000`) |

**Driving a test run:** `npm run dev` runs in simulation and **waits for you** —
nothing plays itself. Open the iPad URL printed in the console in any browser,
then walk the real flow: seat the earbuds (fake-connects), watch the signal-check
waves (fake EEG streams), answer the questions, pick a reading, and the orb +
reveal + outputs all run on the simulated data. If you want an unattended
attract-loop instead (a full fake session cycling on repeat — e.g. for a demo on
a show floor), launch with `FOCUSROOM_DEMO=1`; any real tap takes over from it.
