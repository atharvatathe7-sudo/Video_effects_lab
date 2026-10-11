# Reliability regression tests

`reliability.test.js` drives the real `Video_Effects_Lab.html` in Chromium
through Playwright. The app does not load it, and it adds no hooks to the app.
Everything is observed from outside: the existing `window.VEL` handle, the DOM,
the files the app hands out, and wrappers that the test installs in the page.

## Requirements

- Node.js 18 or newer
- Playwright plus a Chromium with WebCodecs (VP8 `VideoEncoder`). The package
  is not vendored and the suite installs nothing. If it is missing, the run
  exits with code 2 and names what it looked for.

```
node tests/reliability.test.js
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright CHROMIUM_PATH=/path/to/chrome node tests/reliability.test.js
VEL_REPEATS=20 node tests/reliability.test.js          # more renders per frame-selection config
VEL_ONLY=D5 node tests/reliability.test.js             # run tests whose name contains "D5"
VEL_APP=/other/copy.html node tests/reliability.test.js # run against another build (e.g. a baseline)
```

Exit codes: 0 = all passed, 1 = a test failed, 2 = environment unavailable.

## Fixtures

The suite needs no binary files. At startup it builds its clip inside the page
with WebCodecs and the app's own WebM muxer: 480x270, 25 fps, 100 frames, at
exactly 40 ms timestamps. Every frame carries its own index as a barcode, plus
a random colour grid that changes completely on every frame. That means:

- The source frame every output frame should use is known exactly, so frame
  selection is checked against ground truth rather than by majority vote.
- A copy with its Duration element replaced by a Void element of the same size
  gives a file whose duration the browser has to discover by itself.

## Coverage

| Test | Defect / invariant |
|---|---|
| fixture + app basics | 27 effect types; finite duration; exact frame timestamps |
| D3 duration | normal WebM; duration missing from the header (resolved, then rendered); invalid file; a duration that never becomes available (element stub); an end-of-file probe that is never answered (bounded wait) |
| D1 mid-render changes | toggling an effect, changing the output FPS, or changing a parameter mid-render leaves the preview stale; the Download handler refuses it; restoring the rendered settings re-enables Download with the same blob and exactly one render |
| shared blob / zero re-render | preview bytes = Download (twice via the handler, once via a real click on Download WebM); the Preview player plays the rendered file; Download and a repeat Generate Preview construct no encoder |
| D2 source player | real pointer input plus programmatic play/scrub during a render; the player is locked; every frame is checked against ground truth; output matches the untouched render byte for byte; play/seek work afterwards; UI and player are restored after an injected mid-render exception |
| D2 focal seek in flight | a render started while the focal preview is still seeking completes with correct frames |
| D5 frame selection | repeated renders of a baseline at 25 fps, a baseline at 30 fps (intentional repeats), a slow speed ramp (intentional repeats) and an 11-effect stack; every read's presented-frame timestamp (and barcode, where untouched) equals the expected frame; renders are byte-identical; encoded frame count, block timestamps and WebM duration are correct |
| D5 seekVideoTo | exact frame boundaries, just-before boundaries, many requests inside one frame, backwards jumps, end clamp, near-equal times (1.2799 s → 1.28 s must change frame). Requests within 0.5 ms *before a keyframe* are avoided on purpose: Chromium always resolves them to the keyframe, from any seek origin. |
| D4 focal drag | Radial Zoom Blur, Impact Warp, Lens Flare and Depth of Field: Download is disabled during and after a drag, the handler refuses the stale render, and a fresh preview restores Download with the new blob (two renders in total) |
| 27 effects render | each effect renders through the real `FrameRenderer` without error and changes pixels or timing; two untouched reference passes must agree, and a disagreement fails the test instead of being counted as a change |
| preview failure cleanup | after an injected render failure on changed settings: UI unlocked, player restored, the previous preview reattached with the same blob but stale and not downloadable; a fresh preview re-enables Download |
| D6 output FPS | whole numbers 1–120 (including `30.0`) are used as entered; blank, 0, negative, fractional (29.97, 24.5), out-of-range (121, 1000, 1e9) and typed non-numeric input are refused with a specific message and never replaced by another rate; a refused rate renders nothing; valid rates (12, 30) give the expected frame grid; an invalid edit disables Download until the rendered rate is restored |
| D7 clip switch | repeated downloads share one object URL; loading another clip revokes the previous preview and download URLs exactly once each and clears the preview and Download; the new clip's source URL stays live; previewing and downloading the new clip works; a released URL is never revoked twice |
| removed features | no Hook Overlay UI, text or `window.VEL` API, and no separate Export button or export area; Generate Preview and Download WebM remain |

Expected frames follow Chromium's seek semantics: the requested time is
truncated to whole microseconds, and the frame shown is the last one starting
at or before it.

The D5 tests measure a sample. A pass means no wrong frame was seen in that
many reads; it does not prove zero.

## Known unresolved: exact-boundary frame choice

When a requested time lands exactly on a source frame's start, Chromium can
settle on either neighbouring frame depending on decoder state. This was seen
right after load on a MediaRecorder-made portrait clip, and the baseline does
the same. Nothing arrives later, so the seek-readiness wait cannot correct it,
and the suite does not test it. Nudging seek targets off exact boundaries
would address it, but it changes which frames are rendered; that is a deferred
decision.

## Not covered here

The earlier feature suites (Phase 2/3, Group 1/2 effect math, performance, the
download workflow, and `file://` usage) were written in a session scratchpad.
They depend on ~9 MB of pre-generated fixture videos and on a local ffmpeg for
pixel decoding, so they are not part of this directory. They also drive the
Export button, which no longer exists, so they would need adapting to Generate
Preview + Download WebM before they could run again. The Hook Overlay suite is
obsolete because the feature has been removed. This suite recreates their workflow invariants (shared blob, zero re-render,
invalidation, frame count and duration, cleanup after errors, every effect
rendering). It does **not** recreate their per-effect pixel and maths
assertions or their resolution and orientation matrix.
