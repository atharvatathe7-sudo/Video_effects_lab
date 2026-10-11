#!/usr/bin/env node
/*
 * Reliability regression suite for Video_Effects_Lab.html.
 *
 * Drives the real app in Chromium through Playwright. Nothing here is loaded by
 * the app itself and the app gains no test hooks: everything is observed from
 * outside, through the existing window.VEL handle, the DOM, the files the app
 * hands out, and test-side wrappers installed in the page.
 *
 * Fixtures are generated in the page at the start of a run with WebCodecs and
 * the app's own WebM muxer: 4 s, 25 fps, every frame carrying its index as a
 * barcode plus dense full-frame motion, at exactly known 40 ms timestamps. That
 * gives exact ground truth for which source frame every output frame must use.
 *
 * Usage:  node tests/reliability.test.js
 * Env:    PLAYWRIGHT_MODULE  path/name of the playwright package (default: 'playwright')
 *         CHROMIUM_PATH      Chromium executable (default: Playwright's own)
 *         VEL_APP            app HTML to test (default: ../Video_Effects_Lab.html)
 *         VEL_REPEATS        renders per configuration in the frame-selection test (default 6)
 *         VEL_ONLY           comma-separated test-name substrings to run
 * Exit code 0 = all passed, 1 = a test failed, 2 = environment unavailable.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  console.error('Playwright is not available. Set PLAYWRIGHT_MODULE to an installed playwright package.\n' +
    'Tried: ' + candidates.join(', ') + '. Nothing was installed.');
  process.exit(2);
}
const { chromium } = loadPlaywright();

const APP = path.resolve(process.env.VEL_APP || path.join(__dirname, '..', 'Video_Effects_Lab.html'));
const APP_URL = 'file://' + APP;
const REPEATS = Math.max(1, parseInt(process.env.VEL_REPEATS || '6', 10));
const ONLY = (process.env.VEL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

const FPS = 25;              // fixture frame rate; also pinned as the output frame rate
const FRAMES = 100;          // 4.0 s
const FRAME_US = 1e6 / FPS;  // 40000 us, exact in the muxer's 1 ms timecodes
const W = 480, H = 270;
const BITS = 10;

/* ------------------------------------------------------------------ harness */
const results = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function check(cond, what, detail) {
  if (!cond) throw new Error(what + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
function note(msg) { console.log('      · ' + msg); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* ------------------------------------------------------------------ WebM parsing (test side) */
function parseWebM(buf) {
  const U = new Uint8Array(buf);
  function vint(p, keepMarker) {
    const b = U[p]; let len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    let v = keepMarker ? b : (b & (mask - 1)); let allOnes = (b & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + U[p + i]; if (U[p + i] !== 0xff) allOnes = false; }
    return { v, len, unknown: !keepMarker && allOnes };
  }
  const MASTER = new Set([0x18538067, 0x1f43b675, 0x1549a966, 0x1654ae6b, 0xae]);
  const out = { durationMs: null, blocks: [] };
  let clusterTc = 0;
  function walk(p, end) {
    while (p < end && p < U.length) {
      const id = vint(p, true); const size = vint(p + id.len, false);
      const body = p + id.len + size.len;
      const bodyEnd = size.unknown ? end : body + size.v;
      if (MASTER.has(id.v)) { walk(body, bodyEnd); p = bodyEnd; continue; }
      if (id.v === 0x4489) {
        const dv = new DataView(U.buffer, U.byteOffset + body, size.v);
        out.durationMs = size.v === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
      } else if (id.v === 0xe7) {
        let v = 0; for (let i = 0; i < size.v; i++) v = v * 256 + U[body + i]; clusterTc = v;
      } else if (id.v === 0xa3) {
        const tr = vint(body, false);
        const rel = (U[body + tr.len] << 24 >> 16) | U[body + tr.len + 1];
        out.blocks.push({ tsMs: clusterTc + rel, key: !!(U[body + tr.len + 2] & 0x80) });
      }
      p = bodyEnd;
    }
  }
  walk(0, U.length);
  return out;
}

// Replace the Info/Duration element by a Void element of identical length,
// producing a file whose duration the browser has to discover by itself.
function stripDuration(buf) {
  const b = Buffer.from(buf);
  for (let i = 0; i < 400; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89 && (b[i + 2] & 0x80)) {
      const n = b[i + 2] & 0x7f; const total = 3 + n;
      b[i] = 0xec; b[i + 1] = 0x80 | (total - 2);
      for (let k = i + 2; k < i + total; k++) b[k] = 0;
      return b;
    }
  }
  throw new Error('Duration element not found in fixture');
}

/* ------------------------------------------------------------------ in-page fixture generation */
async function generateFixture(browser) {
  const page = await browser.newPage();
  await page.goto(APP_URL);
  const b64 = await page.evaluate(async ({ W, H, FPS, FRAMES, BITS }) => {
    // eslint-disable-next-line no-undef
    const muxer = new WebMMuxer({ width: W, height: H, codecId: 'V_VP8', durationMs: FRAMES * 1000 / FPS });
    let err = null;
    const enc = new VideoEncoder({
      output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); muxer.addFrame(d, chunk.timestamp, chunk.type === 'key'); },
      error: (e) => { err = e; },
    });
    enc.configure({ codec: 'vp8', width: W, height: H, bitrate: 6000000, framerate: FPS });
    const c = new OffscreenCanvas(W, H); const x = c.getContext('2d');
    const hash = (a) => { a = (a ^ 61) ^ (a >>> 16); a = a + (a << 3); a ^= a >>> 4; a = Math.imul(a, 0x27d4eb2d); return (a ^ (a >>> 15)) >>> 0; };
    const bandH = Math.round(H * 0.18);
    for (let k = 0; k < FRAMES; k++) {
      // dense motion: a per-frame random colour grid scrolled by k, plus a moving disc
      const cols = 24, rows = 12, cw = W / cols, ch = (H - bandH) / rows;
      for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
        const h = hash(k * 7919 + r * 131 + q);
        x.fillStyle = 'rgb(' + (h & 255) + ',' + ((h >> 8) & 255) + ',' + ((h >> 16) & 255) + ')';
        x.fillRect(((q * cw + k * 9) % W), bandH + r * ch, cw + 1, ch + 1);
      }
      x.fillStyle = '#fff'; x.beginPath(); x.arc((k * 13) % W, bandH + (H - bandH) / 2, 30, 0, Math.PI * 2); x.fill();
      // frame-index barcode
      x.fillStyle = '#000'; x.fillRect(0, 0, W, bandH);
      const cellW = W / BITS;
      x.fillStyle = '#fff';
      for (let b = 0; b < BITS; b++) if ((k >> b) & 1) x.fillRect(b * cellW + cellW * 0.15, bandH * 0.15, cellW * 0.7, bandH * 0.7);
      const vf = new VideoFrame(c, { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: k % FPS === 0 });
      vf.close();
      if (enc.encodeQueueSize > 8) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    }
    await enc.flush(); enc.close();
    if (err) throw err;
    const buf = new Uint8Array(await muxer.finalize().arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { W, H, FPS, FRAMES, BITS });
  await page.close();
  return Buffer.from(b64, 'base64');
}

/* ------------------------------------------------------------------ page driving */
let browser, FIXTURE, FIXTURE_NODUR;

async function openApp() {
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('      [pageerror] ' + e.message));
  await page.goto(APP_URL);
  // Count VideoEncoder constructions: the renderer cannot produce a frame
  // without one, so an unchanged count proves nothing was rendered.
  await page.evaluate(() => {
    window.__encCount = 0;
    const Real = window.VideoEncoder;
    window.VideoEncoder = function (...a) { window.__encCount++; return new Real(...a); };
    window.VideoEncoder.isConfigSupported = (...a) => Real.isConfigSupported(...a);
    window.VideoEncoder.prototype = Real.prototype;
  });
  return page;
}
const encCount = (page) => page.evaluate(() => window.__encCount);

async function loadClip(page, buffer, name, { expectFailure = false, timeout = 40000 } = {}) {
  await page.setInputFiles('#fileInput', { name: name || 'fixture.webm', mimeType: 'video/webm', buffer });
  await page.waitForFunction(() => !document.getElementById('previewBtn').disabled ||
    /Failed to load/.test(document.getElementById('previewStatus').textContent), null, { timeout });
  const failed = await page.evaluate(() => /Failed to load/.test(document.getElementById('previewStatus').textContent));
  if (!expectFailure) {
    check(!failed, 'clip loads', await page.evaluate(() => document.getElementById('previewStatus').textContent));
    await page.evaluate((fps) => { const e = document.getElementById('outputFpsInput'); e.value = String(fps); e.dispatchEvent(new Event('change', { bubbles: true })); }, FPS);
  }
  return !failed;
}

const fx = (type, start, duration, params) => ({ type, start, duration, enabled: true, params: params || {} });
async function setEffects(page, list) {
  await page.evaluate((l) => {
    const withDefaults = l.map((f) => Object.assign({}, f, { params: Object.assign({}, window.VEL.EFFECT_TYPES[f.type].defaults, f.params) }));
    window.VEL.setEffects(withDefaults);
  }, list);
}

async function startPreview(page) {
  await page.click('#previewBtn');
}
async function waitPreviewDone(page) {
  await page.waitForFunction(() => /Preview ready|failed|Cannot render/.test(document.getElementById('previewStatus').textContent) && !window.VEL.isBusy(), null, { timeout: 300000 });
  return page.evaluate(() => document.getElementById('previewStatus').textContent);
}
async function preview(page) {
  await startPreview(page);
  const st = await waitPreviewDone(page);
  check(/Preview ready/.test(st), 'preview completes', st);
  return st;
}
async function waitRenderUnderway(page, minProgress = 0.1) {
  await page.waitForFunction((m) => window.VEL.isBusy() &&
    parseFloat(document.getElementById('previewProgressBar').style.width) >= m * 100, minProgress, { timeout: 60000 });
}
async function previewBytes(page) {
  const b64 = await page.evaluate(async () => {
    const src = document.getElementById('processedVideo').getAttribute('src');
    if (!src) return null;
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return b64 === null ? null : Buffer.from(b64, 'base64');
}
const dlState = (page) => page.evaluate(() => ({
  disabled: document.getElementById('downloadPreviewBtn').disabled,
  stale: document.getElementById('previewStaleHint').style.display !== 'none',
}));
// Attempts a download through the app's own handler (the button's click
// target), so a disabled button cannot hide a handler that would still serve
// a stale file. Returns the bytes, or null if nothing was downloaded.
async function tryDownload(page, waitMs = 2500) {
  const dlP = page.waitForEvent('download', { timeout: waitMs }).catch(() => null);
  await page.evaluate(() => downloadPreviewRender()); // eslint-disable-line no-undef
  const dl = await dlP;
  if (!dl) return null;
  return fs.readFileSync(await dl.path());
}

// Records, for every frame the renderer reads, the requested source time, the
// element's currentTime, the presented frame's media timestamp and (from the
// renderer's output canvas) the decoded barcode.
async function installReadProbe(page) {
  await page.evaluate(({ BITS }) => {
    const V = window.VEL;
    if (V.FrameRenderer.prototype.__probed) return;
    const orig = V.FrameRenderer.prototype.render;
    const small = document.createElement('canvas');
    const sx = small.getContext('2d', { willReadFrequently: true });
    window.__reads = null;
    V.FrameRenderer.prototype.render = function (video, state, i) {
      const rec = window.__reads && video instanceof HTMLVideoElement;
      let ts = null, ct = null;
      if (rec) { ct = video.currentTime; try { const f = new VideoFrame(video); ts = f.timestamp; f.close(); } catch (e) { ts = -1; } }
      const out = orig.call(this, video, state, i);
      if (rec) {
        const w = out.width, h = out.height, bandH = Math.round(h * 0.18);
        small.width = w; small.height = bandH;
        sx.drawImage(out, 0, 0, w, bandH, 0, 0, w, bandH);
        const d = sx.getImageData(0, 0, w, bandH).data;
        let code = 0; const cellW = w / BITS;
        for (let b = 0; b < BITS; b++) {
          const cx = Math.round(b * cellW + cellW / 2), cy = Math.round(bandH / 2);
          let sum = 0, n = 0;
          for (let yy = cy - 3; yy <= cy + 3; yy++) for (let xx = cx - 3; xx <= cx + 3; xx++) { const o = (yy * w + xx) * 4; sum += (d[o] + d[o + 1] + d[o + 2]) / 3; n++; }
          if (sum / n > 128) code |= (1 << b);
        }
        window.__reads.push({ i, ct, ts, code });
      }
      return out;
    };
    V.FrameRenderer.prototype.__probed = true;
  }, { BITS });
}
async function requestedTimes(page, list, outputFps) {
  return page.evaluate(({ l, fps }) => {
    const V = window.VEL, meta = V.getMeta();
    const effects = l.map((f) => Object.assign({}, f, { params: Object.assign({}, V.EFFECT_TYPES[f.type].defaults, f.params) }));
    const tm = V.TimeMap.build(effects, meta.duration);
    const total = Math.max(1, Math.round(tm.outputDuration * fps));
    const last = Math.max(0, meta.duration - (1 / fps) / 2);
    const cl = (v) => Math.min(Math.max(v, 0), last);
    const out = [];
    for (let i = 0; i < total; i++) out.push(cl(V.computeSourceTime(effects, cl(tm.sourceTimeAt(i / fps)))));
    return out;
  }, { l: list, fps: outputFps });
}
// The source frame a request for time t must show: the last frame starting at
// or before t. Chromium truncates the requested time to whole microseconds
// (t * 1e6 in double precision, then floor), which matters at exact boundaries.
const expectedFrame = (t) => Math.min(FRAMES - 1, Math.floor(Math.floor(t * 1e6) / FRAME_US));

/* ================================================================== tests */

test('fixture + app basics: 27 effects, finite duration, exact frame timestamps', async () => {
  const page = await openApp();
  const n = await page.evaluate(() => Object.keys(window.VEL.EFFECT_TYPES).length);
  check(n === 27, 'exactly 27 effect types', n);
  await loadClip(page, FIXTURE);
  const m = await page.evaluate(() => window.VEL.getMeta());
  check(Math.abs(m.duration - FRAMES / FPS) < 0.01 && m.width === W && m.height === H, 'fixture metadata', m);
  const p = parseWebM(FIXTURE);
  check(p.blocks.length === FRAMES && p.blocks.every((b, k) => b.tsMs === k * 40), 'fixture has 100 frames at exact 40 ms steps');
  note('27 effects; fixture ' + W + 'x' + H + ', ' + FRAMES + ' frames, duration ' + m.duration + 's');
  await page.close();
});

test('D3 duration: normal, missing-from-header, invalid, never-available, no-response', async () => {
  // normal
  let page = await openApp();
  await loadClip(page, FIXTURE);
  check(Math.abs((await page.evaluate(() => window.VEL.getMeta().duration)) - 4) < 0.01, 'normal WebM duration');
  await page.close();

  // duration absent from the header: must be discovered, then usable for a render
  page = await openApp();
  await loadClip(page, FIXTURE_NODUR, 'nodur.webm');
  const d = await page.evaluate(() => ({ meta: window.VEL.getMeta().duration, shown: document.getElementById('infoDuration').textContent }));
  check(isFinite(d.meta) && Math.abs(d.meta - 4) < 0.05, 'missing duration is resolved to the real length', d);
  check(!/Infinity|NaN/.test(d.shown), 'no Infinity/NaN displayed', d.shown);
  await setEffects(page, []);
  await preview(page);
  const parsed = parseWebM(await previewBytes(page));
  // Without a header duration the browser measures the clip itself (to its
  // last frame), so the expected count follows the resolved duration.
  const expectFrames = Math.round(d.meta * FPS);
  check(parsed.blocks.length === expectFrames && expectFrames >= FRAMES - 1, 'render of the resolved clip has the full frame count', parsed.blocks.length + ' vs ' + expectFrames);
  note('header-less duration resolved to ' + d.meta + 's and rendered ' + parsed.blocks.length + ' frames');
  await page.close();

  // invalid file
  page = await openApp();
  const junk = crypto.randomBytes(20000);
  await loadClip(page, junk, 'broken.webm', { expectFailure: true });
  const inv = await page.evaluate(() => ({ status: document.getElementById('previewStatus').textContent, meta: window.VEL.getMeta(), btn: document.getElementById('previewBtn').disabled }));
  check(/Failed to load/.test(inv.status) && inv.meta === null && inv.btn, 'invalid file is rejected with an error', inv);
  await page.close();

  // duration that never becomes available (test-side stub on the element)
  page = await openApp();
  await page.evaluate(() => Object.defineProperty(document.getElementById('sourceVideo'), 'duration', { get: () => Infinity, configurable: true }));
  let t0 = Date.now();
  await loadClip(page, FIXTURE_NODUR, 'nodur.webm', { expectFailure: true });
  let r = await page.evaluate(() => ({ status: document.getElementById('previewStatus').textContent, meta: window.VEL.getMeta(), btn: document.getElementById('previewBtn').disabled }));
  check(/duration/i.test(r.status) && r.meta === null && r.btn, 'unresolvable duration fails with a meaningful error', r);
  note('never-available duration rejected after ' + (Date.now() - t0) + ' ms: "' + r.status.replace(/\s+/g, ' ').slice(0, 110) + '…"');
  await page.close();

  // the browser never answers the end-of-file seek: bounded, not indefinite
  page = await openApp();
  await page.evaluate(() => {
    const v = document.getElementById('sourceVideo');
    Object.defineProperty(v, 'duration', { get: () => Infinity, configurable: true });
    Object.defineProperty(v, 'currentTime', { get: () => 0, set: () => {}, configurable: true });
  });
  t0 = Date.now();
  await loadClip(page, FIXTURE_NODUR, 'nodur.webm', { expectFailure: true, timeout: 40000 });
  const waited = Date.now() - t0;
  r = await page.evaluate(() => ({ status: document.getElementById('previewStatus').textContent, meta: window.VEL.getMeta() }));
  check(/duration/i.test(r.status) && r.meta === null, 'unanswered duration probe ends in an error', r);
  check(waited < 30000, 'bounded wait', waited);
  note('unanswered probe gave up after ' + waited + ' ms');
  await page.close();
});

test('D1 mid-render settings changes never relabel the finished preview', async () => {
  const base = [fx('shake', 0.5, 1.0), fx('vignette', 0.2, 3.0), fx('glowBloom', 1.0, 1.5)];
  const cases = {
    'toggle effect': {
      change: (p) => p.evaluate(() => { const cb = document.querySelector('#effectListBody input[type=checkbox]'); cb.click(); }),
      revert: (p) => p.evaluate(() => { const cb = document.querySelector('#effectListBody input[type=checkbox]'); cb.click(); }),
    },
    'change output FPS': {
      change: (p) => p.evaluate(() => { const e = document.getElementById('outputFpsInput'); e.value = '30'; e.dispatchEvent(new Event('change', { bubbles: true })); }),
      revert: (p) => p.evaluate(() => { const e = document.getElementById('outputFpsInput'); e.value = '25'; e.dispatchEvent(new Event('change', { bubbles: true })); }),
    },
    'change effect parameter': {
      // the editor's own inputs are disabled while busy (asserted below), so the
      // parameter is changed on the live stack object the editor writes to
      change: (p) => p.evaluate(() => { const s = window.__liveStack(); s[0].params.intensity = 'high'; window.__refresh(); }),
      revert: (p) => p.evaluate(() => { const s = window.__liveStack(); s[0].params.intensity = 'medium'; window.__refresh(); }),
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const page = await openApp();
    await loadClip(page, FIXTURE);
    await setEffects(page, base);
    await page.evaluate(() => {
      // test-side access to the live stack and the app's refresh, as the editor uses them
      window.__liveStack = () => EffectStack.all(); // eslint-disable-line no-undef
      window.__refresh = () => refreshEffectsUI();   // eslint-disable-line no-undef
    });
    const before = await encCount(page);
    await startPreview(page);
    await waitRenderUnderway(page, 0.2);
    if (name === 'change effect parameter') {
      const editorDisabled = await page.evaluate(() => [...document.querySelectorAll('#effectEditor input, #effectEditor select')].every((e) => e.disabled));
      check(editorDisabled, 'effect editor inputs are disabled during a render');
    }
    await c.change(page);
    const st = await waitPreviewDone(page);
    check(/Preview ready/.test(st), name + ': preview completes', st);
    const s1 = await dlState(page);
    check(s1.disabled && s1.stale, name + ': Download disabled and marked stale after a mid-render change', s1);
    check((await tryDownload(page)) === null, name + ': download handler refuses the stale render');
    // Restore the settings the render actually used: the retained preview is
    // exactly that render, so it becomes downloadable again without re-rendering.
    await c.revert(page);
    const s2 = await dlState(page);
    check(!s2.disabled && !s2.stale, name + ': restoring the rendered settings re-enables Download', s2);
    const shown = await previewBytes(page);
    const got = await tryDownload(page);
    check(got && got.equals(shown), name + ': downloaded bytes are the previewed blob');
    check((await encCount(page)) === before + 1, name + ': exactly one render for preview + download', (await encCount(page)) - before);
    note(name + ': stale after change, refused, re-enabled on revert, same blob, 1 render');
    await page.close();
  }
  note('effect order cannot be changed in the UI (the stage order is fixed by design), so no reorder case exists');
});

test('Preview and Download share one blob; unchanged settings never re-render', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  await setEffects(page, [fx('punchZoom', 0.5, 0.6), fx('chromaAberration', 1.2, 0.8)]);
  const c0 = await encCount(page);
  await preview(page);
  const c1 = await encCount(page);
  check(c1 === c0 + 1, 'preview renders once');
  const shown = await previewBytes(page);
  const s = await dlState(page);
  check(!s.disabled && !s.stale, 'Download enabled for a fresh preview', s);
  const a = await tryDownload(page); const b = await tryDownload(page);
  check(a && a.equals(shown) && b && b.equals(shown), 'two downloads return the previewed bytes');
  check((await encCount(page)) === c1, 'downloads construct no encoder');
  await preview(page);
  check((await encCount(page)) === c1, 'second preview with unchanged settings reuses the render');
  check((await previewBytes(page)).equals(shown), 'reused preview is the same bytes');
  // the real button, clicked by the user, writes the same file
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#downloadPreviewBtn')]);
  const clicked = fs.readFileSync(await dl.path());
  check(clicked.equals(shown) && /_effects\.webm$/.test(dl.suggestedFilename()), 'Download WebM button saves the previewed bytes', dl.suggestedFilename());
  check((await encCount(page)) === c1, 'the button download constructs no encoder');
  // the preview player plays the rendered file
  const play = await page.evaluate(async () => {
    const v = document.getElementById('processedVideo');
    if (v.readyState < 2) await new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 15000); });
    const t0 = v.currentTime; await v.play(); await new Promise((r) => setTimeout(r, 400)); const advanced = v.currentTime > t0; v.pause();
    return { advanced, w: v.videoWidth, h: v.videoHeight, dur: v.duration };
  });
  check(play.advanced && play.w === W && play.h === H && Math.abs(play.dur - 4) < 0.1, 'the Preview player plays the rendered video', play);
  note('preview ' + sha(shown) + ' == download x3 (2 handler, 1 button click); plays at ' + play.w + 'x' + play.h + '; encoder constructions: 1');
  await page.close();
});

test('D2 source player cannot change rendered frames; interaction restored', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  await installReadProbe(page);
  const effects = [];
  await setEffects(page, effects);
  const req = await requestedTimes(page, effects, FPS);
  const want = req.map(expectedFrame);

  async function render(interfere) {
    await page.evaluate(() => { window.VEL.clearRenderCache(); window.__reads = []; });
    await startPreview(page);
    let locked = null;
    if (interfere) {
      await waitRenderUnderway(page, 0.05);
      locked = await page.evaluate(() => { const v = document.getElementById('sourceVideo'); return { controls: v.controls, pointer: getComputedStyle(v).pointerEvents }; });
      // real pointer input on the player, then programmatic play/seek the way
      // media keys, picture-in-picture or a stray script would
      await page.locator('#sourceVideo').scrollIntoViewIfNeeded();
      const box = await page.locator('#sourceVideo').boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.evaluate(async (mode) => {
        const v = document.getElementById('sourceVideo');
        for (let k = 0; k < 12 && window.VEL.isBusy(); k++) {
          if (mode !== 'scrub') v.play().catch(() => {});
          if (mode !== 'play') v.currentTime = (k * 0.37) % 3.5;
          await new Promise((r) => setTimeout(r, 150));
        }
      }, interfere);
    }
    const st = await waitPreviewDone(page);
    const reads = await page.evaluate(() => window.__reads);
    return { st, bytes: await previewBytes(page), reads, locked };
  }
  const ref = await render(null);
  check(/Preview ready/.test(ref.st), 'untouched render completes', ref.st);
  const badRef = ref.reads.filter((r) => r.code !== want[r.i]).length;
  check(badRef === 0, 'untouched render reads the expected source frame everywhere', badRef);
  for (const mode of ['play', 'scrub', 'play+scrub']) {
    const r = await render(mode);
    check(r.locked && r.locked.controls === false && r.locked.pointer === 'none', mode + ': player locked while rendering', r.locked);
    check(/Preview ready/.test(r.st), mode + ': render completes', r.st);
    const wrong = r.reads.filter((x) => x.code !== want[x.i]);
    check(wrong.length === 0, mode + ': every output frame is the requested source frame', wrong.slice(0, 5));
    check(r.bytes.equals(ref.bytes), mode + ': output identical to the untouched render', sha(r.bytes) + ' vs ' + sha(ref.bytes));
    note(mode + ': ' + r.reads.length + ' frames all correct, bytes == untouched (' + sha(ref.bytes) + ')');
  }
  // interaction restored after success
  const after = await page.evaluate(async () => {
    const v = document.getElementById('sourceVideo');
    const state = { controls: v.controls, pointer: getComputedStyle(v).pointerEvents };
    const sk0 = new Promise((r) => v.addEventListener('seeked', r, { once: true })); v.currentTime = 0.5; await sk0;
    await v.play(); await new Promise((r) => setTimeout(r, 300)); state.played = !v.paused && v.currentTime > 0.5; v.pause();
    const sk = new Promise((r) => v.addEventListener('seeked', r, { once: true })); v.currentTime = 1.23; await sk; state.seekTo = v.currentTime;
    return state;
  });
  check(after.controls && after.pointer !== 'none' && after.played && Math.abs(after.seekTo - 1.23) < 0.01, 'play and seek work again after the render', after);

  // interaction restored after a failure in the middle of a render
  await page.evaluate(() => {
    window.__realEncode = VideoEncoder.prototype.encode;
    let n = 0;
    VideoEncoder.prototype.encode = function (...a) { if (++n === 30) throw new Error('injected encoder failure'); return window.__realEncode.apply(this, a); };
    window.VEL.clearRenderCache();
  });
  await startPreview(page);
  const failSt = await waitPreviewDone(page);
  const fail = await page.evaluate(() => { const v = document.getElementById('sourceVideo'); return { busy: window.VEL.isBusy(), controls: v.controls, pointer: getComputedStyle(v).pointerEvents, preview: !document.getElementById('previewBtn').disabled, file: !document.getElementById('fileInput').disabled }; });
  check(/failed/.test(failSt) && /injected/.test(failSt), 'injected failure is reported', failSt);
  check(!fail.busy && fail.controls && fail.pointer !== 'none' && fail.preview && fail.file, 'UI and player restored after the failure', fail);
  await page.evaluate(() => { VideoEncoder.prototype.encode = window.__realEncode; });
  await preview(page);
  note('controls/pointer input restored after success and after an injected mid-render exception');
  await page.close();
});

test('D2 focal-preview seek still in flight when a render starts does not disturb it', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  await installReadProbe(page);
  const effects = [fx('radialBlur', 2.5, 1.0)];
  await setEffects(page, effects);
  const want = (await requestedTimes(page, effects, FPS)).map(expectedFrame);
  let wrongTotal = 0;
  for (let r = 0; r < 4; r++) {
    await page.evaluate(() => { window.VEL.clearRenderCache(); window.__reads = []; });
    // Rebuilding the editor starts a focal still (a seek to the effect's peak);
    // the render is started in the same task, while that seek is pending.
    await page.evaluate(() => { document.querySelector('#effectListBody tr td.fxname').click(); document.getElementById('previewBtn').click(); });
    const st = await waitPreviewDone(page);
    check(/Preview ready/.test(st), 'render completes despite the pending focal seek', st);
    const reads = await page.evaluate(() => window.__reads);
    const wrong = reads.filter((x) => x.ts !== want[x.i] * FRAME_US);
    wrongTotal += wrong.length;
    check(wrong.length === 0, 'every frame is the requested source frame', wrong.slice(0, 5));
  }
  note('4 renders started during a pending focal seek: all completed, 0 wrong frames');
  await page.close();
});

test('D5 frame selection: every read is the requested frame, renders are identical', async () => {
  const configs = {
    'baseline 25fps': { effects: [], fps: 25 },
    'baseline 30fps (intentional repeats)': { effects: [], fps: 30 },
    'slow ramp (intentional repeats)': { effects: [fx('speedRamp', 0.8, 1.5, { speed: '0.5' })], fps: 25 },
    'heavy stack': {
      effects: [fx('shake', 0.3, 1.0), fx('dutchTilt', 0.3, 1.2), fx('impactWarp', 0.8, 0.4), fx('glowBloom', 0.3, 2.0),
        fx('chromaAberration', 1.0, 0.5), fx('radialBlur', 1.2, 0.5), fx('motionBlur', 1.6, 0.8), fx('focusBlur', 2.0, 1.0),
        fx('waveWarp', 2.2, 0.8), fx('vignette', 0.3, 3.0), fx('ghostTrail', 2.5, 1.0)],
      fps: 25,
    },
  };
  const page = await openApp();
  await loadClip(page, FIXTURE);
  await installReadProbe(page);
  let totalReads = 0, totalWrong = 0, totalRenders = 0;
  for (const [name, cfg] of Object.entries(configs)) {
    await setEffects(page, cfg.effects);
    await page.evaluate((f) => { const e = document.getElementById('outputFpsInput'); e.value = String(f); e.dispatchEvent(new Event('change', { bubbles: true })); }, cfg.fps);
    const req = await requestedTimes(page, cfg.effects, cfg.fps);
    const want = req.map(expectedFrame);
    const outDur = await page.evaluate((l) => window.VEL.TimeMap.build(l.map((f) => Object.assign({}, f, { params: Object.assign({}, window.VEL.EFFECT_TYPES[f.type].defaults, f.params) })), window.VEL.getMeta().duration).outputDuration, cfg.effects);
    const usesPixels = cfg.effects.length === 0; // barcode survives only an untouched frame
    const hashes = {}; let wrong = 0, reads = 0, repeats = 0;
    for (let k = 1; k < want.length; k++) if (want[k] === want[k - 1]) repeats++;
    for (let r = 0; r < REPEATS; r++) {
      await page.evaluate(() => { window.VEL.clearRenderCache(); window.__reads = []; });
      await preview(page);
      const rs = await page.evaluate(() => window.__reads);
      const bytes = await previewBytes(page);
      hashes[sha(bytes)] = (hashes[sha(bytes)] || 0) + 1;
      check(rs.length === want.length, name + ': one read per output frame', rs.length + ' vs ' + want.length);
      for (const x of rs) {
        reads++;
        const okTs = x.ts === want[x.i] * FRAME_US;
        const okPix = !usesPixels || x.code === want[x.i];
        if (!okTs || !okPix) { wrong++; if (wrong <= 5) note(name + ' run ' + r + ' frame ' + x.i + ': wanted source frame ' + want[x.i] + ', presented ts ' + x.ts + (usesPixels ? ', barcode ' + x.code : '')); }
      }
      const parsed = parseWebM(bytes);
      check(parsed.blocks.length === want.length, name + ': encoded frame count', parsed.blocks.length);
      check(parsed.blocks.every((b, i) => b.tsMs === Math.round(i * 1000 / cfg.fps)), name + ': encoded frame timestamps');
      check(Math.abs(parsed.durationMs - outDur * 1000) < 0.5, name + ': WebM duration equals the time-map output duration', parsed.durationMs + ' vs ' + outDur * 1000);
    }
    totalReads += reads; totalWrong += wrong; totalRenders += REPEATS;
    note(name + ': ' + REPEATS + ' renders x ' + want.length + ' frames = ' + reads + ' reads (' + repeats + ' intentional repeats per render), wrong reads ' + wrong + ', distinct outputs ' + Object.keys(hashes).length);
    check(wrong === 0, name + ': no read of an unexpected frame', wrong);
    check(Object.keys(hashes).length === 1, name + ': repeated renders are byte-identical', hashes);
  }
  note('total: ' + totalRenders + ' renders, ' + totalReads + ' frame reads, ' + totalWrong + ' wrong (a sample, not a proof of zero)');
  await page.close();
});

test('D5 seekVideoTo: boundaries, same frame, backwards, end clamp, back-to-back', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  const seq = [];
  for (let k = 0; k < 30; k++) seq.push(k / FPS);                 // exact frame starts
  for (let k = 1; k < 20; k++) seq.push(k / FPS - 0.0002);        // just before a boundary
  for (let k = 0; k < 10; k++) seq.push(1 + k * 0.003);           // many requests inside one frame
  for (let k = 0; k < 15; k++) seq.push(3.98 - k * 0.27);         // backwards jumps
  // Large jumps and near-equal times. (Requests within 0.5 ms BEFORE a keyframe
  // are avoided: Chromium deterministically resolves those to the keyframe --
  // e.g. 1.9995 s shows the 2.000 s keyframe -- whatever the seek origin.)
  seq.push(0, 3.98, 0, 3.98, 2, 2.0001, 1.999, 0.5, 1.2799, 1.28);
  const rows = await page.evaluate(async (seq) => {
    const v = document.getElementById('sourceVideo');
    const out = [];
    for (const t of seq) {
      await seekVideoTo(v, t); // eslint-disable-line no-undef
      const f = new VideoFrame(v); out.push({ t, ts: f.timestamp, ct: v.currentTime }); f.close();
    }
    return out;
  }, seq);
  const bad = rows.filter((r) => r.ts !== expectedFrame(r.t) * FRAME_US);
  check(bad.length === 0, 'presented frame is the expected one after every seek', bad.slice(0, 5));
  note(rows.length + ' seeks (boundaries, sub-frame, backwards, end, near-equal) all presented the expected frame');
  await page.close();
});

test('D4 focal-point drag invalidates the preview for all four focal effects', async () => {
  const types = ['radialBlur', 'impactWarp', 'lensFlare', 'focusBlur'];
  const page = await openApp();
  await loadClip(page, FIXTURE);
  for (const type of types) {
    await setEffects(page, [fx(type, 1.0, 1.5)]);
    await page.click('#effectListBody tr td.fxname');
    await page.waitForSelector('.focal-stage');
    await page.waitForFunction(() => /Showing source time/.test((document.querySelector('.focal-wrap p.hint:last-child') || {}).textContent || ''), null, { timeout: 20000 }).catch(() => {});
    const c0 = await encCount(page);
    await preview(page);
    check(!(await dlState(page)).disabled, type + ': Download enabled after preview');
    await page.locator('.focal-stage').scrollIntoViewIfNeeded();
    const box = await page.locator('.focal-stage').boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3, { steps: 5 });
    const mid = await dlState(page);
    await page.mouse.up();
    const end = await dlState(page);
    check(mid.disabled && mid.stale, type + ': Download disabled while dragging', mid);
    check(end.disabled && end.stale, type + ': Download disabled after the drag', end);
    check((await tryDownload(page)) === null, type + ': handler refuses the stale render');
    await preview(page);
    const fresh = await dlState(page);
    check(!fresh.disabled && !fresh.stale, type + ': fresh preview restores Download', fresh);
    const shown = await previewBytes(page);
    const got = await tryDownload(page);
    check(got && got.equals(shown), type + ': Download returns the new preview blob');
    check((await encCount(page)) === c0 + 2, type + ': only the two previews rendered', (await encCount(page)) - c0);
    note(type + ': stale during and after drag, refused, fresh preview downloadable, 2 renders');
  }
  await page.close();
});

test('all 27 effects render through the real pipeline and change the output', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  const res = await page.evaluate(async () => {
    const V = window.VEL, meta = V.getMeta();
    const v = document.getElementById('sourceVideo');
    const hashOf = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0x811c9dc5; for (let k = 0; k < d.length; k += 16) { h ^= d[k]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
    // consecutive source frames 0.80 s .. 1.96 s, with frame history, as the pipeline renders them
    const frames = []; for (let k = 20; k < 50; k++) frames.push(k);
    async function run(effects) {
      const r = new V.FrameRenderer(meta.width, meta.height); r.enableHistory(12);
      const out = [];
      for (const k of frames) { const t = k / 25; await seekVideoTo(v, t); out.push(hashOf(r.render(v, V.computeFrameState(effects, t, meta.width, meta.height, k), k, null))); } // eslint-disable-line no-undef
      return out;
    }
    const base = await run([]);
    const base2 = await run([]);
    // A frame is only evidence of change where two untouched passes agree;
    // a disagreement between them is reported, not absorbed.
    const unstable = frames.filter((k, i) => base[i] !== base2[i]);
    const out = {};
    for (const type of Object.keys(V.EFFECT_TYPES)) {
      const eff = [{ id: 1, type, start: 0.8, duration: 1.2, enabled: true, params: Object.assign({}, V.EFFECT_TYPES[type].defaults) }];
      let changedPixels = false, error = null;
      try { const h = await run(eff); changedPixels = h.some((x, i) => base[i] === base2[i] && x !== base[i]); } catch (e) { error = e.message; }
      const tm = V.TimeMap.build(eff, meta.duration);
      const changedTime = Math.abs(tm.outputDuration - meta.duration) > 1e-6 || frames.some((k) => V.computeSourceTime(eff, k / 25) !== k / 25);
      out[type] = { changedPixels, changedTime, error };
    }
    return { out, unstable };
  });
  const unstable = res.unstable;
  check(unstable.length === 0, 'two untouched reference passes are identical', unstable);
  const fxRes = res.out;
  const failing = Object.entries(fxRes).filter(([, v]) => v.error || !(v.changedPixels || v.changedTime));
  check(Object.keys(fxRes).length === 27, '27 effects exercised', Object.keys(fxRes).length);
  check(failing.length === 0, 'every effect renders without error and changes pixels or timing', failing);
  note('27/27 effects render; pixel-changing: ' + Object.values(fxRes).filter((v) => v.changedPixels).length + ', timing-only: ' + (Object.entries(fxRes).filter(([, v]) => !v.changedPixels && v.changedTime).map(([k]) => k).join(', ') || 'none'));
  await page.close();
});

test('preview failure cleans up: UI unlocked, player restored, old preview kept but not downloadable', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  await setEffects(page, [fx('vignette', 0.2, 3.0)]);
  await preview(page);
  const shown = await previewBytes(page);
  await setEffects(page, [fx('vignette', 0.2, 3.0), fx('shake', 1, 1)]);
  await page.evaluate(() => {
    window.__realEncode = VideoEncoder.prototype.encode; let n = 0;
    VideoEncoder.prototype.encode = function (...a) { if (++n === 40) throw new Error('injected render failure'); return window.__realEncode.apply(this, a); };
  });
  await startPreview(page);
  const st = await waitPreviewDone(page);
  const s = await page.evaluate(() => {
    const v = document.getElementById('sourceVideo');
    return { busy: window.VEL.isBusy(), controls: v.controls, pointer: getComputedStyle(v).pointerEvents,
      previewBtn: !document.getElementById('previewBtn').disabled, file: !document.getElementById('fileInput').disabled,
      src: !!document.getElementById('processedVideo').getAttribute('src') };
  });
  check(/failed/.test(st) && /injected render failure/.test(st), 'render failure reported', st);
  check(!s.busy && s.controls && s.pointer !== 'none' && s.previewBtn && s.file, 'UI and player unlocked after the failure', s);
  check(s.src && (await previewBytes(page)).equals(shown), 'previous preview reattached with the same blob', s);
  const d = await dlState(page);
  check(d.disabled && d.stale, 'the previous preview no longer matches the settings, so Download stays off', d);
  check((await tryDownload(page)) === null, 'nothing downloadable after the failed render');
  await page.evaluate(() => { VideoEncoder.prototype.encode = window.__realEncode; });
  await preview(page);
  check(!(await dlState(page)).disabled, 'a successful preview afterwards re-enables Download');
  note('render failure: status reported, controls restored, old preview reattached but stale, fresh preview downloadable');
  await page.close();
});

test('D6 output FPS: whole numbers 1-120 accepted, everything else refused with a message', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  const setFps = (v) => page.evaluate((v) => { const e = document.getElementById('outputFpsInput'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const fpsState = () => page.evaluate(() => {
    const box = document.getElementById('outputFpsError');
    return { fps: window.VEL.getOutputFps(), shown: box.style.display !== 'none', msg: box.textContent, value: document.getElementById('outputFpsInput').value };
  });

  // the detected default is kept as it was and is valid
  await page.evaluate(() => { const e = document.getElementById('outputFpsInput'); e.dispatchEvent(new Event('input', { bubbles: true })); });
  const def = await page.evaluate(() => document.getElementById('outputFpsInput').value);
  check(/^\d+$/.test(def) && +def >= 1 && +def <= 120, 'detected default is a valid whole number', def);

  for (const [v, want] of [['1', 1], ['25', 25], ['30', 30], ['60', 60], ['120', 120], ['30.0', 30]]) {
    await setFps(v);
    const s = await fpsState();
    check(s.fps === want && !s.shown, 'valid entry ' + JSON.stringify(v) + ' is used as ' + want + ' with no error', s);
  }
  const invalid = [['', /empty/], ['0', /outside/], ['-5', /outside/], ['121', /outside/], ['1000', /outside/], ['29.97', /whole number/], ['24.5', /whole number/], ['1e9', /outside/]];
  for (const [v, re] of invalid) {
    await setFps(v);
    const s = await fpsState();
    check(Number.isNaN(s.fps), 'invalid entry ' + JSON.stringify(v) + ' is not replaced by another rate', s);
    check(s.shown && re.test(s.msg) && /1 to 120/.test(s.msg), 'invalid entry ' + JSON.stringify(v) + ' shows a clear message', s.msg);
  }
  // non-numeric typing: the number input reports badInput and an empty value
  await setFps('');
  await page.locator('#outputFpsInput').focus();
  await page.keyboard.type('e');
  const bad = await fpsState();
  check(Number.isNaN(bad.fps) && bad.shown && /not a number/.test(bad.msg), 'non-numeric entry shows "not a number"', bad);

  // an invalid rate is refused before any rendering
  await setEffects(page, [fx('vignette', 0.2, 3.0)]);
  for (const v of ['', '0', '29.97', '121']) {
    await setFps(v);
    const c0 = await encCount(page);
    await page.click('#previewBtn');
    const st = await page.evaluate(() => document.getElementById('previewStatus').textContent);
    check(/Cannot render/.test(st) && /whole number between 1 and 120/.test(st), 'preview refused for ' + JSON.stringify(v), st);
    check((await encCount(page)) === c0, 'nothing rendered for ' + JSON.stringify(v));
    const info = await page.evaluate(() => document.getElementById('infoOutputDuration').textContent);
    check(/invalid/.test(info) && !/NaN/.test(info), 'output info explains the invalid rate', info);
  }

  // valid rates still drive the output grid exactly as before
  for (const v of [12, 30]) {
    await setFps(String(v));
    await preview(page);
    const p = parseWebM(await previewBytes(page));
    const outDur = await page.evaluate(() => window.VEL.getMeta().duration);
    check(p.blocks.length === Math.round(outDur * v) && p.blocks.every((b, i) => b.tsMs === Math.round(i * 1000 / v)), v + ' fps render has the expected frame grid', p.blocks.length);
  }
  // an invalid edit after a preview makes Download unavailable; the rendered rate restores it
  await setFps('abc');
  check((await dlState(page)).disabled, 'Download disabled while the rate is invalid');
  await setFps('30');
  check(!(await dlState(page)).disabled, 'Download available again for the rendered rate');
  note('valid: 1, 25, 30, 60, 120, 30.0; refused with messages: blank, 0, -5, 121, 1000, 29.97, 24.5, 1e9, typed "e"; refused entries render nothing');
  await page.close();
});

test('D7 loading another clip releases the previous preview and download URLs, and only them', async () => {
  const page = await openApp();
  await page.evaluate(() => {
    window.__revoked = []; window.__created = [];
    const realRevoke = URL.revokeObjectURL.bind(URL), realCreate = URL.createObjectURL.bind(URL);
    URL.revokeObjectURL = (u) => { window.__revoked.push(u); realRevoke(u); };
    URL.createObjectURL = (o) => { const u = realCreate(o); window.__created.push(u); return u; };
  });
  const urlLive = (u) => page.evaluate(async (u) => { try { const r = await fetch(u); return r.ok; } catch (e) { return false; } }, u);
  await loadClip(page, FIXTURE, 'first.webm');
  await setEffects(page, [fx('vignette', 0.2, 3.0)]);
  await preview(page);
  const processedURL = await page.evaluate(() => document.getElementById('processedVideo').getAttribute('src'));
  const createdBefore = await page.evaluate(() => window.__created.length);
  check(await tryDownload(page), 'preview downloads');
  check(await tryDownload(page), 'preview downloads again');
  const made = await page.evaluate((n) => window.__created.slice(n), createdBefore);
  check(made.length === 1, 'repeated downloads reuse one object URL', made);
  const downloadURL = made[0];
  check(await urlLive(processedURL) && await urlLive(downloadURL), 'preview and download URLs are live while the preview is current');
  const before = await page.evaluate(() => ({ src: document.getElementById('sourceVideo').src, revoked: window.__revoked.length }));

  await loadClip(page, FIXTURE, 'second.webm');
  const after = await page.evaluate(() => ({
    src: document.getElementById('sourceVideo').src, revoked: window.__revoked.slice(),
    processed: document.getElementById('processedVideo').getAttribute('src'),
    dl: document.getElementById('downloadPreviewBtn').disabled,
    ready: document.getElementById('sourceVideo').readyState,
  }));
  const newlyRevoked = after.revoked.slice(before.revoked);
  for (const [name, u] of [['preview', processedURL], ['download', downloadURL]]) {
    check(newlyRevoked.filter((x) => x === u).length === 1, 'previous ' + name + ' URL revoked exactly once on clip switch', newlyRevoked);
    check(!(await urlLive(u)), 'previous ' + name + ' blob no longer reachable');
  }
  check(after.processed === null && after.dl, 'previous clip\'s preview and Download are cleared', after);
  check(after.src !== before.src && !after.revoked.includes(after.src) && after.ready >= 1 && await urlLive(after.src), 'the new clip\'s source URL is untouched and in use');
  await preview(page);
  const fresh = await page.evaluate(() => document.getElementById('processedVideo').getAttribute('src'));
  check(fresh && await urlLive(fresh) && (await tryDownload(page)), 'previewing and downloading the new clip works');
  await loadClip(page, FIXTURE, 'third.webm');
  const final = await page.evaluate(() => window.__revoked.slice());
  check([processedURL, downloadURL].every((u) => final.filter((x) => x === u).length === 1), 'an already released URL is never revoked twice');
  note('clip switch revoked the old preview and download URLs once each and cleared Download; new source URL live; new preview downloadable');
  await page.close();
});

test('Hook Overlay and the separate Export button are gone', async () => {
  const page = await openApp();
  await loadClip(page, FIXTURE);
  const r = await page.evaluate(() => ({
    hookIds: ['hookEnabled', 'hookText', 'hookDuration', 'hookFontPct', 'hookHint'].filter((id) => document.getElementById(id)),
    exportIds: ['exportBtn', 'exportStatus', 'exportProgressWrap', 'downloadArea', 'outputInfoTable'].filter((id) => document.getElementById(id)),
    hookText: /hook/i.test(document.body.innerText),
    exportButtons: [...document.querySelectorAll('button')].filter((b) => /export/i.test(b.textContent)).map((b) => b.textContent),
    velHook: Object.keys(window.VEL).filter((k) => /hook/i.test(k)),
    buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /Preview|Download/.test(t)),
  }));
  check(r.hookIds.length === 0 && !r.hookText && r.velHook.length === 0, 'no Hook Overlay UI, text or API remains', r);
  check(r.exportIds.length === 0 && r.exportButtons.length === 0, 'no separate Export button or export area remains', r);
  check(r.buttons.includes('Generate Preview') && r.buttons.includes('Download WebM'), 'Generate Preview and Download WebM remain', r.buttons);
  note('hook ids/text/API: none; export controls: none; buttons: ' + r.buttons.join(', '));
  await page.close();
});

/* ================================================================== run */
(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  } catch (e) {
    console.error('Chromium could not be launched (' + e.message.split('\n')[0] + '). Set CHROMIUM_PATH.');
    process.exit(2);
  }
  console.log('App: ' + APP + '\nRepeats per frame-selection config: ' + REPEATS + '\n');
  FIXTURE = await generateFixture(browser);
  FIXTURE_NODUR = stripDuration(FIXTURE);
  let failed = 0;
  for (const t of tests) {
    if (ONLY.length && !ONLY.some((o) => t.name.includes(o))) continue;
    const t0 = Date.now();
    console.log('▶ ' + t.name);
    try {
      await t.fn();
      console.log('  PASS (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
      results.push({ name: t.name, ok: true });
    } catch (e) {
      failed++;
      console.log('  FAIL: ' + e.message);
      results.push({ name: t.name, ok: false, error: e.message });
      for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.close().catch(() => {});
    }
  }
  await browser.close();
  console.log('\n' + results.filter((r) => r.ok).length + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
