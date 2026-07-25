/* ZONE — THE FOCUS ROOM · iPad screens (part 2)
   Reading (+ interruption) · StrongestQ · Standby · Email · Close */
(function () {
  const { useState, useEffect, useRef } = React;
  const e = React.createElement;
  const { Mono, DotMark, PillBtn, ArrowRow, Arrow, DarkField, LightField } = window;
  const FL = window.FocusLine;
  const wrap = (extra) => ({ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', ...extra });

  // Curated reading bodies, keyed to the picked piece id. Content slots — each
  // array is the full body of one piece; the Reading screen renders the paragraphs
  // for answers.piece.id (falling back to 'keeper'). No placeholder line ships.
  const READING_BODIES = {
    keeper: [
      'The lamp had been dark for three nights before anyone on the mainland noticed. By then the tide had come and gone six times, and whatever the keeper had meant to write in the logbook stopped, mid-sentence, on the page dated the fourth.',
      'I took the boat out myself. The dock was intact. The door was unlocked. Inside, a kettle sat cold on the stove and a chair faced the window as though someone had only just stood up from it.',
      'It was the footprints that stayed with me. Three sets, leading from the water to the door, pressed deep into sand that no one had walked since the storm. None of them led back out. I counted them twice, the way you check a number you already know is wrong.',
      'There is a particular silence inside a lighthouse with no light. It is not the absence of sound but the presence of waiting — the building itself seeming to hold its breath for the beam that does not come.',
      'I have read the final entry more times than I can admit. It is four words long. It is not a distress call, and it is not a goodbye, and it is the reason I keep coming back to that page, turning it over, looking for the sentence that should have followed.'
    ],
    octopus: [
      'Consider the octopus, and then consider what you mean by the word think.',
      'We tend to keep our thinking in one place. It sits behind the eyes, in the soft grey knot we have learned to call the self, and the rest of the body waits on its instructions. The octopus does not keep its thinking in one place. Of the roughly five hundred million neurons that make up its nervous system, only about a third are gathered in the central brain that rings its gullet. The other two-thirds are spread down its eight arms, which means a great deal of the animal is, quite literally, thinking with its hands.',
      'Each arm can act on its own. Severed from the body in a laboratory, an arm will still reach for food and recoil from a pinch, running through its small repertoire of decisions without waiting to be told. In the living animal this looks less like obedience than negotiation. The central brain sets an intention, find the crab under that rock, and the arms work out the details for themselves, tasting as they go. An octopus tastes with its skin. Every sucker is lined with receptors, so the animal knows the flavour of what it touches before it has any picture of what it is.',
      'The blood that feeds all this is blue. Where ours carries oxygen on iron and runs red, theirs carries it on copper, which turns pale blue in the cold, low-oxygen water many species prefer. Three hearts push it along: two to the gills, one to the body, the last of them stopping whenever the animal swims, which is part of why octopuses would rather crawl.',
      'Then there is the matter of colour. An octopus can vanish against a rock in a fraction of a second, matching not only its shade but its texture, raising and flattening the skin into folds that mimic weed and stone. It does this, as far as anyone can tell, while being colour-blind. Its eyes carry a single kind of light receptor. The skin itself may hold part of the answer, since it is studded with the same light-sensitive proteins found in eyes, as though the animal sees, dimly and all over, with its whole surface.',
      'What unsettles people who work with octopuses is not the strangeness of the machinery but the presence behind it. They solve problems no reflex could account for. They open jars, work loose the lids of their tanks, and carry coconut shells across the seabed to assemble later into shelter. They appear to recognise individual keepers and to hold opinions about them, favouring some with calm and dousing others with a jet from the siphon. In captivity they grow bored, and a bored octopus is a destructive one.',
      'All of this evolved on a branch of the tree of life that split from ours more than five hundred million years ago, before anything had a backbone, before there were fish. Whatever the octopus is doing when it plans and remembers and decides, it arrived there by a different road. Its intelligence is not a lesser version of ours, or an earlier draft of it. It is a separate invention, a second answer to the same question, worked out in the dark by an animal that holds its mind in its arms.',
      'To watch one work is to feel the ground shift a little under the idea that a mind must look like ours to count. Here is a creature that lives about two years, learns fast, forgets nothing that matters to it, and dies alone, having taught itself most of what it knew. It is the nearest thing to an alien intelligence we are ever likely to hold in our hands, and it has been here the whole time, folded into the rocks, watching us back.'
    ],
    cartographer: [
      'The coastline was not where the chart said it should be.',
      'Mara had surveyed the northern reach for eleven summers, and she trusted the old charts the way you trust a handrail in the dark, without looking, letting them take the weight. They had never been wrong in a way that mattered. A shoal drifted a fathom here, a sandbar softened there, but the land itself held still, and a cartographer learns to love the land for that stillness. It is the one thing that keeps its promises.',
      'So when the fog lifted on the fourth morning and showed her a headland no chart had ever carried, she did not believe it. She believed instead in a trick of the light, in tiredness, in the way a low sun can build cathedrals out of cloud. She took her bearings twice. She took them a third time. The headland stayed where it was, dark and patient, a long grey arm of rock reaching into water her chart insisted was open sea.',
      'She rowed toward it. This was not sensible, and she knew it was not sensible, but there is a hunger in the trade that overrides good sense, the need to put a hand on the thing and say I was here, it is real. The rock, when she reached it, was real. It was streaked white with old droppings and hung with weed, and the swell broke against its foot in the ordinary way, throwing spray that wet her sleeve and tasted of salt like any other sea. She tied up in a cleft and climbed.',
      'From the top she could see the shape of it whole. A spit of land perhaps two miles long, curving to shelter a bay that opened its mouth to the north. Sand the colour of ash. A freshwater stream cutting down through the grass. No mark of any keel, no cairn, no cut stump, nothing that said a person had stood here before her. She sat down on the cold ground and understood, slowly, that she was looking at something no one had written down.',
      'The understanding was not the pleasure she had expected. It arrived instead as a weight, because a cartographer does not simply find a coast. She reports it. She draws it, names it, and hands it up the chain to the men who commission charts and the men who read them, and those men are not painters. A coast on a chart is a coast that can be reached, and a coast that can be reached is a coast that will be. She had watched it happen to gentler places than this. The chart came first, and the boats came after, and the silence she was sitting in now, the particular silence of a place that has never once heard a human voice, would end with the scratch of her own pen.',
      'She stayed until the light began to go. She drew nothing. She let the shape of the bay settle into her memory the way you memorise a face you know you will not see again, then climbed down to the boat, untied it, and rowed back out into the fog.',
      'That night, in the low cabin with the lamp swinging, she opened the survey book to the blank leaf where the day’s work should go. She held the pen over it for a long time. The honest thing was to draw. The trade she had given her life to was built on the plain faith that what is real should be recorded, that a map withheld is a kind of lie. She believed that. She had always believed it.',
      'She turned the pen in her fingers and thought about the ash-coloured sand, and the stream, and the two miles of grass that no one had named, and she thought about who the naming would be for. Then she dipped the nib, and she began to write, and only she would ever know what it was she chose to set down.'
    ],
    signal: [
      'On the night of the fifteenth of August, 1977, a radio telescope in Ohio heard something, and no one has been able to explain it since.',
      'The telescope was called the Big Ear. It belonged to Ohio State University, and it did not move the way the great dishes move, swivelling to follow a target. It lay still and let the sky turn over it, reading whatever drifted through its beam as the Earth carried it around. A computer logged the strength of each signal as a single character, a rough shorthand: a blank or a low number for the ordinary hiss of the universe, higher numbers and then letters for anything louder. Most nights the paper came out quiet, a field of ones and twos, the sky going about its business.',
      'A few days later a volunteer named Jerry Ehman sat down with the printout, running his eye along the columns the way he had a hundred times before. Partway down a page he found a sequence that did not belong. Against the low murmur of the background stood six characters in a rising and falling run: 6EQUJ5. In the code of the machine that meant a signal which had climbed to more than thirty times the noise around it, swelled, and faded, all in the space of seventy-two seconds. Ehman circled it in red pen and wrote a single word in the margin. Wow.',
      'The seventy-two seconds were themselves a kind of signature. That was exactly how long any fixed point in the sky would take to drift across the Big Ear’s beam. A signal that rose and fell across just that window was behaving precisely as something out there, beyond the Earth, would behave. It was not a passing car or a satellite or a stray reflection off the ground. It came from the sky, and it kept the sky’s time.',
      'Stranger still was where it sat on the dial. The signal fell very close to 1420 megahertz, the frequency at which hydrogen, the commonest thing in the universe, quietly sings. For years people had argued that if anyone were ever going to call across the dark on purpose, this is the frequency they would choose, precisely because any astronomer anywhere would be listening near it. The signal arrived almost exactly there, in the one part of the spectrum we had guessed a message might use.',
      'And then it was gone. Ehman and others went back to that patch of sky, in the direction of the constellation Sagittarius, again and again over the years that followed. They pointed better instruments at it. They listened for hours. There was nothing. Whatever had spoken that night said its single loud thing and fell silent, and it has not spoken since.',
      'Explanations have been offered and none has held. It was too strong and too clean to be dismissed easily, too brief and too solitary to be confirmed. A comet was proposed as the source and later doubted. Interference from Earth was ruled out by the very shape of the seventy-two seconds. What remains is a circled line on a page of old printout, and a word written in the margin by a man who knew exactly what he was looking at and exactly how little he could prove.',
      'This is what makes the signal so hard to set down. It is not a photograph of a spaceship or a message we have decoded. It is something smaller and harder to let go of: one clean note, at the right frequency, from the right kind of nowhere, heard once and never again. Almost certainly there is a natural answer we have not yet found. Almost certainly. But the honest position, decades on, is that we do not know what we heard, and the sky has not offered to tell us twice.'
    ]
  };

  /* ---------------- READING (light) + interruption overlay ---------------- */
  function Reading({ go, answers, interruption, notice, onScroll }) {
    const [showInt, setShowInt] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    // How far through the piece the guest has actually read, reported on the
    // shared clock so the reveal can lay reading pace against the brain data.
    // Rate-limited and change-gated: the raw scroll event fires dozens of times
    // per flick, and every one of those would be a websocket message.
    const bodyRef = useRef(null);
    const lastSent = useRef({ t: 0, p: -1 });
    const sampleScroll = () => {
      const el = bodyRef.current;
      if (!el || !onScroll) return;
      const span = el.scrollHeight - el.clientHeight;
      const p = span > 20 ? Math.max(0, Math.min(1, el.scrollTop / span)) : 0;
      const now = Date.now();
      if (now - lastSent.current.t < 1500 && Math.abs(p - lastSent.current.p) < 0.02) return;
      lastSent.current = { t: now, p };
      onScroll(p);
    };
    // one sample on arrival marks the start of the page, even if they never scroll
    useEffect(() => { sampleScroll(); }, []);
    const piece = answers.piece || { title: 'Your reading', meta: '4 min' };
    // no silent substitution: an unmapped piece renders an honest note, never
    // another piece's body ('own' has no body until the paste step lands)
    const body = READING_BODIES[piece.id] || null;
    // SYNCED: the interruption fires from main on the real plateau (interruption
    // prop). STANDALONE preview (file://) only: a short timer raises a sample card
    // so the beat can be reviewed. Never runs when served.
    useEffect(() => {
      if (location.host || interruption) return;
      const t = setTimeout(() => setShowInt(true), 5200); return () => clearTimeout(t);
    }, [interruption]);
    // a fresh real interruption (new t) clears any earlier dismissal so the real
    // card is never suppressed by a dismissed preview card.
    useEffect(() => { if (interruption) setDismissed(false); }, [interruption && interruption.t]);
    const overlay = !dismissed && (interruption || showInt);
    const mind = (interruption && interruption.onMind) || answers.mind;

    return e(LightField, null,
      e('div', { style: wrap({ padding: 0 }) },
        // sticky reading header
        e('div', { style: { padding: '54px 60px 22px', borderBottom: '1px solid rgba(20,20,20,0.06)', background: 'rgba(245,243,239,0.86)', backdropFilter: 'blur(6px)' } },
          e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 } },
            e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, e(DotMark, { size: 9, glow: false, color: 'var(--c-near-black)' }),
              e(Mono, { color: 'var(--fg-light-muted)' }, 'Reading · live')),
            e(Mono, { color: 'var(--fg-light-muted)' }, piece.meta || '')),
          e('h2', { className: 't-h2', style: { color: 'var(--fg-light)', fontSize: 34, letterSpacing: '-0.02em' } }, piece.title)),
        // body
        e('div', { 'data-slot': 'reading_body', ref: bodyRef, onScroll: sampleScroll,
          style: { flex: 1, overflowY: 'auto', padding: '40px 60px 30px' } },
          body
            ? body.map((p, i) => e('p', { key: i, style: { fontFamily: 'var(--font-sans)', fontWeight: 300, fontSize: 22, lineHeight: 1.62, color: '#2A2823', marginBottom: 26, maxWidth: 640 } }, p))
            : e(Mono, { color: 'var(--fg-light-muted)' }, 'Your piece loads here')),
        // footer action
        e('div', { style: { padding: '20px 60px 48px', borderTop: '1px solid rgba(20,20,20,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
          e(Mono, { color: 'var(--fg-light-muted)' }, 'Read at your own pace'),
          e(PillBtn, { onClick: go }, 'I’ve finished reading')),

        // interruption card
        overlay ? e(Interruption, { mind: mind, onBack: () => { setShowInt(false); setDismissed(true); } }) : null,

        // signal-trouble reseat coaching (never a broken line — just a small nudge)
        // A hardware nudge is NOT the interruption: it used to render in the
        // interruption orange, mid-reading, spending the room's one accent
        // moments before the real notification landed. Muted now, and docked to
        // the bottom so it can't cover the sticky reading header.
        notice === 'reseat' ? e('div', { style: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: '14px 24px',
          background: 'rgba(20,20,20,0.06)', borderTop: '1px solid rgba(20,20,20,0.12)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, zIndex: 30 } },
          e(DotMark, { size: 8, glow: false, color: 'var(--fg-light-muted)' }),
          e('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-light-muted)' } },
            'Settling the earbud for a sharper read')
        ) : null
      )
    );
  }

  function Interruption({ mind, onBack }) {
    return e('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      background: 'rgba(20,19,18,0.34)', backdropFilter: 'blur(3px)', paddingTop: 130 } },
      e('div', { style: { width: 600, background: 'var(--c-white)', borderRadius: 24, padding: '30px 32px',
        boxShadow: '0 24px 60px rgba(0,0,0,0.28)', animation: 'cardDrop 420ms var(--ease-out)' } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 } },
          e('span', { style: { width: 34, height: 34, borderRadius: 10, background: 'var(--c-near-black)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, e(DotMark, { size: 11 })),
          e('div', null,
            e('div', { style: { fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, color: 'var(--c-near-black)' } }, 'A note you left yourself'),
            e(Mono, { color: 'var(--fg-light-muted)', style: { fontSize: 8 } }, 'Just now'))),
        e('p', { style: { fontFamily: 'var(--font-sans)', fontWeight: 400, fontSize: 22, lineHeight: 1.35, color: 'var(--c-near-black)', marginBottom: 10 } },
          'Still circling: “', e('span', { style: { fontWeight: 500 } }, mind || 'the thing you came in carrying'), '.”'),
        e('p', { style: { fontFamily: 'var(--font-sans)', fontWeight: 300, fontSize: 16, lineHeight: 1.45, color: 'var(--fg-light-muted)', marginBottom: 24 } },
          'You flagged this on your way in. It’s still here when you surface.'),
        e('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
          e(PillBtn, { onClick: onBack, style: { padding: '15px 28px', fontSize: 16 } }, 'Back to reading'))
      )
    );
  }

  /* ---------------- STRONGEST-STRETCH QUESTION (light, single tap) ---------------- */
  function StrongestQ({ go, answers, setAnswers }) {
    // labels match the choice vocabulary reads.js GUESS_REGION expects verbatim —
    // stored as answers.strongestGuess and sent as payload.choice by the controller.
    const opts = ['The opening', 'The turn partway through', 'The ending', 'Honestly, I’m not sure'];
    // the 220ms is a visual dwell (the row highlights before the screen moves);
    // the answer rides go's overrides so it can never race the render
    const pick = (o) => { setAnswers({ ...answers, strongestGuess: o }); setTimeout(() => go({ strongestGuess: o }), 220); };
    return e(LightField, null,
      e('div', { style: wrap({ padding: '88px 60px 64px', justifyContent: 'center' }) },
        e(Mono, { color: 'var(--fg-light-muted)', style: { marginBottom: 22 } }, 'One quick guess'),
        e('h2', { className: 't-h2', style: { color: 'var(--fg-light)', fontSize: 38, lineHeight: 1.08, letterSpacing: '-0.02em', marginBottom: 18, maxWidth: 600 } }, 'Which part felt sharpest?'),
        e('p', { className: 't-body', style: { color: 'var(--fg-light-muted)', fontSize: 17, marginBottom: 40, maxWidth: 520 } }, 'No right answer. We’ll show you where your focus actually peaked in a moment.'),
        e('div', { style: { display: 'flex', flexDirection: 'column', gap: 13 } },
          opts.map((o, i) => e(ArrowRow, { key: i, onClick: () => pick(o), selected: answers.strongestGuess === o }, o)))
      )
    );
  }

  /* ---------------- STANDBY (dark, hand off to the TV) ---------------- */
  /* quiet mono text-button — the signature micro-label as a real touch target.
     minHeight 48 canvas px ≈ 45pt after the 3:4 cover scale (HIG ≥44pt); press
     feedback matches PillBtn (scale 0.975). */
  function QuietBtn({ onClick, dark, style, children }) {
    const [press, setPress] = useState(false);
    return e('button', {
      onClick,
      onPointerDown: () => setPress(true),
      onPointerUp: () => setPress(false),
      onPointerLeave: () => setPress(false),
      style: {
        background: 'transparent', border: 'none', cursor: 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 'var(--tr-mono)',
        textTransform: 'uppercase', minHeight: 48, padding: '12px 20px',
        color: dark ? 'var(--fg-faint)' : 'var(--fg-light-muted)',
        transform: press ? 'scale(0.975)' : 'none', transition: 'transform var(--dur-fast)',
        ...style,
      },
    }, children);
  }

  function Standby({ go }) {
    return e(DarkField, { glow: true },
      e('div', { style: wrap({ padding: 64, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }) },
        e('div', { style: { animation: 'breathe 3.4s var(--ease-in-out) infinite', marginBottom: 38 } }, e(DotMark, { size: 18 })),
        e('h2', { className: 't-h2', style: { color: 'var(--fg-strong)', fontSize: 40, marginBottom: 16 } }, 'Look up.'),
        e('p', { className: 't-body', style: { color: 'var(--fg-muted)', fontSize: 19, maxWidth: 440, lineHeight: 1.5 } }, 'Your reading’s done. The screen across the room has the rest, and we’ll walk through what your focus did.'),
        e('div', { style: { position: 'absolute', bottom: 96, left: 0, right: 0, display: 'flex', justifyContent: 'center' } },
          e(QuietBtn, { onClick: go, dark: true, style: { opacity: 0.65 } }, 'Reveal finished · continue ›'))
      )
    );
  }

  /* ---------------- EMAIL CAPTURE (light) ---------------- */
  function Email({ go, answers, setAnswers }) {
    const [val, setVal] = useState(answers.email || '');
    const trimmed = val.trim();
    const ok = /^\S+@\S+\.\S+$/.test(trimmed);
    // store the value, then advance on the next tick so the controller reads the
    // committed answers (send-report is gated on a truthy email downstream).
    const submit = () => { setAnswers({ ...answers, email: trimmed }); go({ email: trimmed }); };
    const skip = () => { setAnswers({ ...answers, email: '' }); go({ email: '' }); };
    return e(LightField, null,
      e('div', { style: wrap({ padding: '88px 60px 64px', justifyContent: 'center' }) },
        e(Mono, { color: 'var(--fg-light-muted)', style: { marginBottom: 22 } }, 'Your report'),
        e('h2', { className: 't-h2', style: { color: 'var(--fg-light)', fontSize: 40, letterSpacing: '-0.02em', marginBottom: 16, maxWidth: 560 } }, 'Where should we send the full read?'),
        e('p', { className: 't-body', style: { color: 'var(--fg-light-muted)', fontSize: 18, marginBottom: 40, maxWidth: 520 } }, 'Your annotated line and the four reads, written out. It lands before you leave the building.'),
        e('input', { type: 'email', value: val, autoFocus: true, onChange: ev => setVal(ev.target.value),
          placeholder: 'you@company.com',
          style: { width: '100%', background: 'var(--c-white)', border: ok ? '1.5px solid var(--c-near-black)' : '1px solid rgba(20,20,20,0.1)', borderRadius: 18,
            padding: '24px 26px', fontFamily: 'var(--font-sans)', fontWeight: 400, fontSize: 22, color: 'var(--c-near-black)', outline: 'none', marginBottom: 26, boxShadow: '0 1px 3px rgba(20,20,20,0.04)' } }),
        e(PillBtn, { full: true, disabled: !ok, onClick: submit }, 'Send my report'),
        e('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 16 } },
          e(QuietBtn, { onClick: skip }, 'No thanks, just the card'))
      )
    );
  }

  /* ---------------- CLOSE (light, 3 matched variants) ---------------- */
  const DOORS = {
    investor: { who: 'Investor', cta: 'See where this goes',
      line: 'Today was one room and one reading. The roadmap is the same signal, every workday, for years, with your focus learning its own shape over time.',
      note: 'A look at the roadmap and where the data goes over the next few years.' },
    customer: { who: 'Customer', cta: 'Join the beta',
      line: 'Today was a glimpse. The earbud is the version that follows you out, learning how you settle, your rhythm, and the moment your focus starts to break.',
      note: 'An early invite to wear Zone in your own week.' },
    creator: { who: 'Creator / Athlete', cta: 'Get your Focus Profile',
      line: 'Your archetype is yours to keep. Take the profile, post it if you like, and wear the version that tracks this across every session.',
      note: 'Your shareable profile and an early-access path.' }
  };
  function Close({ go, answers, setAnswers, outputs, reveal }) {
    // door: guest-facing default is 'investor'. The switcher below is review-only
    // and writes the choice into answers so the controller sends payload.door.
    const device = typeof document !== 'undefined' && document.body.classList.contains('device');
    const who = answers.door || 'investor';
    const d = DOORS[who];
    const out = outputs || {};
    const arch = (answers.archetype || 'deep');
    const archName = (FL && FL.ARCH[arch]) ? FL.ARCH[arch].name : 'Deep Diver';
    // The takeaway line is the guest's OWN line. It used to be
    // FL.linePath(archetype), the synthetic generator curve — so the last thing
    // a guest saw was a shape belonging to their archetype in general and to
    // nobody's session in particular, and it matched neither the wall nor the
    // printed card. Feed the real samples; only fall back to the generator when
    // the reveal never arrived (standalone preview).
    const box = { x: 8, y: 10, w: 304, h: 60 };
    const real = reveal && reveal.samples && reveal.samples.length > 3;
    let lineKey = arch;
    if (real && FL) {
      FL.setSamples('closeline', reveal.samples,
        reveal.interruptT != null ? { interruptT: reveal.interruptT } : null);
      lineKey = 'closeline';
    }
    // The synthetic generator curve belongs to the standalone (file://) preview
    // ONLY. Served in the room with no reveal (a reloaded Safari lost it and
    // the re-send hasn't landed yet), draw nothing — a blank slot is honest, a
    // generic archetype curve on a real guest's takeaway is not.
    const served = typeof location !== 'undefined' && !!location.host;
    const path = FL && (real || !served) ? FL.linePath(lineKey, box, { samples: 140 }) : '';
    // the same figures the wall quoted, so the two never disagree
    const reads = (reveal && reveal.reads) || [];
    const facts = reads.filter((r) => r && r.stat && r.stat.value).slice(0, 3);
    const setDoor = (k) => setAnswers({ ...answers, door: k });
    // honest takeaway: only name what the outputs pipeline confirmed. The email
    // sends on the CTA tap (close_choice → send-report), so before that moment
    // an entered address earns intent — "will follow" — never "is in your inbox".
    const willEmail = !!answers.email;
    const takeaway = out.cardPrinted && out.emailSent
      ? 'Take your card · your report is in your inbox'
      : out.cardPrinted && willEmail ? 'Take your card · your report will follow by email'
        : out.cardPrinted ? 'Take your card on the way out'
          : out.emailSent ? 'Your report is in your inbox'
            : willEmail ? 'Your report will follow by email'
              : 'Your reading is complete';
    return e(LightField, null,
      e('div', { style: wrap({ padding: '60px 60px 56px' }) },
        // review-only door switch — hidden in device mode (door stays 'investor')
        device ? null : e('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: 34 } },
          e('div', { style: { display: 'inline-flex', background: 'rgba(20,20,20,0.05)', borderRadius: 'var(--r-pill)', padding: 4, gap: 2 } },
            Object.keys(DOORS).map(k => e('button', { key: k, onClick: () => setDoor(k),
              style: { border: 'none', cursor: 'pointer', borderRadius: 'var(--r-pill)', padding: '9px 16px',
                fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
                background: who === k ? 'var(--c-near-black)' : 'transparent', color: who === k ? 'var(--c-offwhite)' : 'var(--fg-light-muted)', transition: 'all 160ms' } }, DOORS[k].who)))),
        e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' } },
          e(Mono, { color: 'var(--fg-light-muted)', style: { marginBottom: 16 } }, 'In your session today, you read as'),
          e('h1', { className: 't-h1', style: { color: 'var(--fg-light)', fontSize: 60, letterSpacing: '-0.03em', marginBottom: 22 } }, archName),
          // the guest's own line, with the notification marked where it landed
          e('svg', { viewBox: '0 0 320 80', width: 320, height: 80, style: { marginBottom: facts.length ? 22 : 30 } },
            e('path', { d: path, fill: 'none', stroke: 'var(--c-near-black)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.85 }),
            real && reveal.interruptT != null && FL
              ? (() => { const pt = FL.pointAt(lineKey, Math.max(0, Math.min(1, reveal.interruptT)), box);
                  return e('circle', { cx: pt.x, cy: pt.y, r: 3.4, fill: 'var(--c-orange)' }); })()
              : null),
          // the measured figures, carried over verbatim from the wall
          facts.length ? e('div', { style: { display: 'flex', gap: 40, marginBottom: 30, flexWrap: 'wrap' } },
            facts.map((r, i) => e('div', { key: i, style: { minWidth: 120 } },
              e('div', { style: { fontFamily: 'var(--font-display)', fontSize: 26, lineHeight: 1.1,
                color: r.k === 'Interruption' ? 'var(--c-orange)' : 'var(--c-near-black)' } }, r.stat.value),
              e('div', { style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--fg-light-muted)', marginTop: 5, maxWidth: 170, lineHeight: 1.4 } }, r.stat.label)))) : null,
          e('p', { className: 't-body', style: { color: '#2A2823', fontSize: 20, lineHeight: 1.45, marginBottom: 36, maxWidth: 580 } }, d.line),
          e(PillBtn, { onClick: go, style: { padding: '20px 40px', alignSelf: 'flex-start' } }, d.cta),
          e('p', { className: 't-body-2', style: { color: 'var(--fg-light-muted)', marginTop: 18, fontSize: 14 } }, d.note)
        ),
        e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 } },
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, e(DotMark, { size: 9, glow: false, color: 'var(--c-near-black)' }), e(Mono, { color: 'var(--fg-light-muted)' }, takeaway)))
      )
    );
  }

  Object.assign(window, { Reading, StrongestQ, Standby, Email, Close });
})();
