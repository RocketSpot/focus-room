'use strict';
// ============================================================
// tests/eeg-event-timing.test.js — Phase 2A.2 correction 2: the interruption is a
// MULTIMODAL event (iPad visual card + room-audio duck). Proves the markers are kept
// SEPARATE, each in its own documented clock domain, never collapsed into one "exact"
// timestamp, with a PREDECLARED primary marker, a reported uncertainty, and NO
// sample-accurate / device-sample-counter claim.  node tests/eeg-event-timing.test.js
// ============================================================
process.env.FOCUSROOM_PROCESS_MS = '0';
process.env.FOCUSROOM_PLATEAU_FALLBACK_MS = '600000';
process.env.FOCUSROOM_REVEAL_STEP_MS = '600000';

const path = require('path');
const { Orchestrator } = require(path.join(__dirname, '..', 'app', 'orchestrator.js'));

let failures = 0;
const check = (n, c, d) => { if (c) console.log('  ok   ' + n); else { failures++; console.error(' FAIL  ' + n + (d !== undefined ? ' — ' + d : '')); } };
const makeOrch = () => new Orchestrator({ supervisor: { send: () => true }, server: { broadcast: () => {} }, log: () => {} });
const ev = (o, k, p) => o.onClientMessage({ type: 'guest/event', kind: k, payload: p, t: Date.now() }, 'ipad');
const intake = (o, f) => o.onClientMessage(Object.assign({ type: 'guest/intake', t: Date.now() }, f), 'ipad');

const orch = makeOrch();
orch.onClientHello({ role: 'ipad', clientTime: Date.now() });
ev(orch, 'earbud_seated');
ev(orch, 'fit_confirmed');
intake(orch, { answers: { 0: 'x' }, onMind: 'a deadline' });
intake(orch, { reading: { id: 'octopus', title: 'How an Octopus Thinks' } });
check('reached reading', orch.beat === 'reading', orch.beat);
orch.onSidecar({ type: 'eeg/frame', tRel: 0, t: Date.now(), engagementRel: 0.5, signalQuality: 1 }); // anchor timeline
const fired = orch.forceInterruption();
check('interruption fired', fired === true && orch.interruptionFired === true);

const T = orch.interruptionTiming;
console.log('\n-- multimodal event schema --');
check('eventType is combined visual + audio', T.eventType === 'combined-visual-card-and-room-audio-duck', T.eventType);
check('SEPARATE visual + audioDuck + eegAlignment markers', !!(T.visual && T.audioDuck && T.eegAlignment) && T.visual !== T.audioDuck);
check('primary marker is PREDECLARED', typeof T.primaryMarkerDefinition === 'string' && /rendered/i.test(T.primaryMarkerDefinition));
check('secondary markers listed separately', Array.isArray(T.secondaryMarkers) && T.secondaryMarkers.length >= 1);
check('visual carries a MONOTONIC request time (not Date.now-only)', typeof T.visual.requestMonotonicMs === 'number');
check('audio carries a monotonic request time too', typeof T.audioDuck.requestMonotonicMs === 'number');
check('clock domains documented + distinct', T.visual.clockDomain === 'ipad-browser' && T.audioDuck.clockDomain === 'room-audio-browser');
check('no device sample counter → no sample-accurate alignment', T.eegAlignment.deviceSampleCounterAvailable === false && T.eegAlignment.deviceSampleIndex === null);
check('an uncertainty is reported (not exact) + confidence low', T.eegAlignment.estimatedUncertaintyMs > 0 && T.timingConfidence === 'low');
check('markers start empty — nothing fabricated', T.visual.renderedFrameMonotonicMs === null && T.audioDuck.scheduledAudioContextTime === null);
check('interruption media names both modalities', Array.isArray(T.media) && T.media.indexOf('ipad_visual_card') >= 0 && T.media.indexOf('room_audio_duck') >= 0);

console.log('\n-- visual marker: filled by the iPad render report (double-rAF) --');
orch.onClientMessage({ type: 'guest/event', kind: 'notification_shown',
  payload: { shownAt: Date.now(), renderedMonotonicMs: 1234.5, clockDomain: 'ipad-browser' }, t: Date.now() }, 'ipad');
check('visual.renderedFrameMonotonicMs filled from the iPad clock', T.visual.renderedFrameMonotonicMs === 1234.5);
check('timing method upgraded to ipad_render_report', T.timingMethod === 'ipad_render_report');
check('render-report receive time recorded (orchestrator clock)', typeof T.visual.renderReportReceivedMonotonicMs === 'number');
check('audio marker STILL separate + untouched by the visual report', T.audioDuck.scheduledAudioContextTime === null);

console.log('\n-- audio-duck marker: filled by room-audio (its own audio clock) --');
orch.onRoomAudioEvent({ type: 'audio/event', kind: 'ducked',
  payload: { scheduledAudioContextTime: 12.5, requestMonotonicMs: 5000, estimatedStartMonotonicMs: 5010, baseLatency: 0.005, outputLatency: 0.01, clockDomain: 'room-audio-browser' } });
check('audioDuck.scheduledAudioContextTime filled from room-audio', T.audioDuck.scheduledAudioContextTime === 12.5);
check('visual + audio markers remain DISTINCT (never one collapsed onset)', T.audioDuck.scheduledAudioContextTime === 12.5 && T.visual.renderedFrameMonotonicMs === 1234.5);
orch.onRoomAudioEvent({ payload: { scheduledAudioContextTime: 99 } });
check('a second audio report is ignored (one duck per fire)', T.audioDuck.scheduledAudioContextTime === 12.5);

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
