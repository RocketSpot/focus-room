# Zone, The Focus Room: test package

Snapshot of commit `b43243e`. This is the exact room code the demo film was
captured from, plus one extra tool for testing on hardware.

If you are a Claude instance picking this up cold, read the whole file before
running anything. The short version of where this stands:

> The signal pipeline was rebuilt because an awake guest reading a book measured
> 77% delta. That is now fixed and heavily tested, **but only against synthetic
> EEG**. It has never been run on a brain. The single most valuable thing anyone
> can do with this package is section 3.

---

## 1. Setup

Node 18+ and Python 3.10+. Everything in the project itself is
cross-platform; only the virtualenv layout differs, because Windows puts
executables in `Scripts\` where Unix uses `bin/`.

**Windows**

```
npm ci
python -m venv venv
venv\Scripts\pip install numpy scipy bleak
npm run build:ipad
```

Run Python through the venv from then on, so it can see numpy, scipy and bleak:
`venv\Scripts\python tools\bud-check.py`. If `python` is not recognised, try
`py -m venv venv` instead.

**macOS or Linux**

```bash
npm ci
python3 -m venv venv
venv/bin/pip install numpy scipy bleak
npm run build:ipad
```

`npm run build:ipad` is not optional. `ipad/dist/app.js` is the bundle the room
actually serves and it is not in version control, so without this step the iPad
screens are missing entirely.

Two things are deliberately absent from this package:

- **`.env`**, which holds a Postmark key. Email sending is off without it. That
  is fine for everything below.
- **PP Neue Montreal**, the display face, which is a paid licence. The room
  falls back to Space Grotesk. Type will look slightly different from the film.
  Nothing else changes.

---

## 2. Check the build, no hardware needed

```bash
npm test
```

Expect roughly 300 checks across Node and Python, all passing, ending with
`4 python test file(s) passed`. If Python tests are skipped rather than run,
something is wrong with the venv: the runner is written to FAIL rather than
skip, precisely because the old suite silently skipped and a broken pipeline
shipped.

The one to read if you only read one:

```bash
venv/bin/python tests/eeg-spectral.test.py        # Windows: venv\Scripts\python
```

It asserts the thing that was actually broken. On a pure 1/f background with no
oscillation present at all, every band must read within 0.6 dB of zero. Under
the old statistic the same input gave delta 20% at spectral exponent 1.0 and
47% at 2.0, which is where the 77% came from.

---

## 3. THE TEST THAT MATTERS: does it measure a brain?

You need one Zone earbud and about ninety seconds. **No other machine, no TV,
no iPad.** The buds talk BLE, so this only works within a few metres of the bud,
but it works from any laptop.

```bash
venv/bin/python tools/bud-check.py               # Windows: venv\Scripts\python tools\bud-check.py
```

It finds the bud, works out which characteristics it answers on, then walks you
through thirty seconds eyes open and thirty seconds eyes closed, and prints the
five bands for both.

**Why this test.** Occipital alpha rises sharply when the eyes close. It is the
oldest reliable effect in EEG, and the reason it is the right test here is that
nothing changes between the two windows except the brain: same electrode, same
skin, same filter, same fit. No baseline calibration, no trusting anyone's
numbers. Alpha rises or it does not.

At the ear the effect is weaker than at the scalp, so:

| alpha change | reading |
|---|---|
| 2 dB or more | the pipeline is measuring a brain |
| 1 to 2 dB | suggestive, run again with `--seconds 60` |
| under 1 dB | not demonstrated, and that is a real result |

It also prints delta. Under about 1.5 dB means the original failure mode is gone
on real data rather than only in tests.

The raw counts are saved to `data/validation/`, locked to your user and
gitignored, so the recording can be re-analysed offline afterwards without the
hardware present. That file is the most useful thing you can send back.

**It also answers a second question for free.** It tries both BLE UUID families
found in the field and reports which one replied. See section 6.

---

## 4. Run the room, simulated

```bash
npm run dev
```

Electron opens the TV surface. The iPad is a browser on the same network:
`http://<your-ip>:4321/ipad-flow.html`. The operator console is
`http://localhost:4321/ops.html`.

Everything is labelled `SIMULATED DATA` on screen. The simulator now generates
1/f noise carrying broad oscillatory bumps and runs it through the same analyser
the hardware path uses, so a dev run genuinely exercises the shipped DSP. It
used to emit hand-written band constants that never touched the analyser, which
is how a completely broken pipeline still looked perfect in simulation.

What to look at, in order:

1. **The signal check.** Five stacked band waveforms, delta rolling slowly and
   gamma fast and fine. Both lanes should be clearly coloured. Previously the
   left ear drew at 10% opacity, because `ctx.strokeStyle = 'var(--c-signal)'`
   is silently ignored by Canvas.
2. **The orb during the reading.** It should loop with no pulse and no cut. The
   clips are now baked to loop; the page uses plain `<video loop>`.
3. **The reveal.** Delta must not be the top line, and read 03 must always carry
   a quantified change.

---

## 5. Re-shoot the demo film

```bash
npx electron tools/demo-capture.js
tools/demo-render.sh
```

Takes about four minutes to capture and thirty seconds to render, producing
`data/demo/focus-room-demo.mp4` at 1920x1080.

Be clear about what the film's data is, because this was got wrong once already:
the guest's **choices** come from the recorded session (their intake answers,
the note "the board deck", the Octopus reading, their guess). All the **EEG** is
generated live by the simulator and labelled as such on screen. No recorded EEG
is replayed, because raw ADC is deliberately never persisted.

---

## 6. Known blockers, worth knowing before promising anything

**The room may not be able to talk to the earbuds at all.** Its BLE catalogue
probes `efaecafe-abac-beef-...` while both reference GUI scripts use
`00000000-2fda-...`. If `bud-check.py` connects on a 2fda set, that mismatch is
confirmed and the catalogue needs the UUIDs added. This likely explains why
hardware validation never happened.

**Nothing here is calibrated to microvolts.** The ADC scale factor exists in the
reference scripts but was deliberately not adopted, so no surface ever labels a
unit. Every reported quantity is a ratio against the guest's own background,
which is what makes it honest without a calibration.

**One real session exists and it is unusable.** `session-1785017923930` measured
77% delta and the room correctly classed it `insufficient-usable-data`. It
predates all of this work and cannot be used to validate the new pipeline: raw
ADC was not retained, so it cannot be re-analysed.

---

## 7. What changed, in one paragraph each

**Band processing.** Bands were reported as a share of total power. EEG has a
1/f background, so the band nearest DC wins that comparison however clean the
signal is. The room now fits each guest's own 1/f background and measures how
far each band rises above it, in dB, which reads zero when there is no rhythm
and reports delta honestly when there is one. Three things compounded it and are
also fixed: the SDK averaged four channels in the time domain before the PSD
(amplifying common-mode drift by a factor of 23), Welch averaged exactly one
segment (56% coefficient of variation), and the artifact stage was a no-op.

**The notification.** Three separate paths returned no number at all. The band
shift is now the headline always, because something always moves at the marker,
and the recovery time moved into the sentence rather than displacing it.

**The orb.** Two stacked layers at complementary opacities composite to
`1 - t + t^2`, which bottoms at 0.75, so a quarter of the frame fell through on
every loop. And the clips were never loop-authored. Fixed in the assets, by
`tools/bake-orb-loops.sh`, not in CSS.

**The signal screen.** No mains notch existed and the high-pass was primed
backwards, producing a 32,775-count spike on every gap. Both fixed; it now shows
five band lanes.

**The slides.** Wave glyphs were drawn about one band too high with a 1:5 spread
where the truth is 1:13. The deck was cut off by a missing `minHeight: 0` and by
centring each slide independently. Verified across five iPad geometries.

**Lead-off.** The transport was pinned to 9-byte packets, so the firmware's
inline contact bits were unreachable. Both layouts now decode, giving the
operator live contact during a reading rather than only before one.
