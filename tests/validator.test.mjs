import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, sniff } from '../src/lib/validator/probe.js';
import { checkFile } from '../src/lib/validator/checks.js';
import * as mk from './helpers.mjs';

const IAB_MREC = { creative_types: ['image', 'animated-image', 'html5'], dimensions: [{ width: 300, height: 250 }, { width: 600, height: 500, label: '2x retina' }], file: { formats: ['jpg', 'png', 'gif', 'html5'], max_size_kb: 150, initial_load_kb: 150 } };
const CTV = { creative_types: ['video'], dimensions: [{ width: 1920, height: 1080 }], file: { formats: ['mp4', 'mov'], max_size_kb: 1024 * 1024 }, video: { allowed_durations_s: [15, 30], containers: ['mp4', 'mov'], video_codecs: ['H.264', 'ProRes 422 HQ'], audio_codecs: ['AAC', 'PCM'], frame_rates: [23.98, 29.97, 30] } };
const statusOf = (res, rule) => res.results.find((r) => r.rule === rule)?.status;

// ---------- probing ----------
test('sniffs every supported format from magic bytes', () => {
  assert.equal(sniff(new Uint8Array(mk.png(1, 1))), 'png');
  assert.equal(sniff(new Uint8Array(mk.gif(1, 1))), 'gif');
  assert.equal(sniff(new Uint8Array(mk.jpg(1, 1))), 'jpg');
  assert.equal(sniff(new Uint8Array(mk.webpVP8X(1, 1))), 'webp');
  assert.equal(sniff(new Uint8Array(mk.zip([['a', 'b']]))), 'zip');
  assert.equal(sniff(new Uint8Array(mk.mp4())), 'mp4');
  assert.equal(sniff(new Uint8Array(mk.mp4({ brand: 'qt  ' }))), 'mov');
  assert.equal(sniff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test('reads image sizes and animation', async () => {
  assert.deepEqual(await pick(mk.png(300, 250), 'a.png'), { kind: 'image', width: 300, height: 250 });
  assert.deepEqual(await pick(mk.png(300, 250, { animated: true }), 'a.png'), { kind: 'animated-image', width: 300, height: 250 });
  assert.deepEqual(await pick(mk.gif(728, 90, 3), 'a.gif'), { kind: 'animated-image', width: 728, height: 90 });
  assert.deepEqual(await pick(mk.gif(728, 90, 1), 'a.gif'), { kind: 'image', width: 728, height: 90 });
  assert.deepEqual(await pick(mk.jpg(1080, 1920), 'a.jpg'), { kind: 'image', width: 1080, height: 1920 });
  assert.deepEqual(await pick(mk.webpVP8X(1200, 628), 'a.webp'), { kind: 'image', width: 1200, height: 628 });
});
async function pick(bytes, name) { const m = await probe(mk.file(bytes, name)); return { kind: m.kind, width: m.width, height: m.height }; }

test('reads video header whether moov is first or last', async () => {
  for (const moovAtEnd of [false, true]) {
    const m = await probe(mk.file(mk.mp4({ seconds: 15, fps: 30, moovAtEnd, mdatBytes: 5000 }), 'v.mp4'));
    assert.equal(m.kind, 'video');
    assert.equal(m.width, 1920); assert.equal(m.height, 1080);
    assert.equal(m.durationS, 15);
    assert.equal(m.videoCodec, 'H.264'); assert.equal(m.audioCodec, 'AAC');
    assert.equal(m.fps, 30);
  }
});

test('names HEVC, ProRes and silent videos correctly', async () => {
  const hevc = await probe(mk.file(mk.mp4({ video: 'hvc1', audio: null }), 'v.mov'));
  assert.equal(hevc.videoCodec, 'H.265'); assert.equal(hevc.audioCodec, null);
  const prores = await probe(mk.file(mk.mp4({ brand: 'qt  ', video: 'apch', audio: 'lpcm' }), 'v.mov'));
  assert.equal(prores.videoCodec, 'ProRes 422 HQ'); assert.equal(prores.audioCodec, 'PCM'); assert.equal(prores.format, 'mov');
});

test('inspects HTML5 zips', async () => {
  const good = await probe(mk.file(mk.zip([['index.html', '<meta name="ad.size" content="width=300,height=250"><script>var clickTag="";</script>'], ['img.jpg', 'x']]), 'ad.zip'));
  assert.equal(good.kind, 'html5'); assert.equal(good.hasHtml, true); assert.equal(good.hasClickTag, true);
  assert.equal(good.width, 300); assert.equal(good.fileCount, 2);
  const bad = await probe(mk.file(mk.zip([['x/other.txt', 'hi']]), 'ad.zip'));
  assert.equal(bad.hasHtml, false); assert.equal(bad.hasClickTag, false);
});

test('rejects unknown and damaged files with a clear message', async () => {
  const txt = await probe(mk.file([104, 101, 108, 108, 111, 0, 0, 0], 'notes.txt'));
  assert.match(txt.error, /Unrecognized/);
  assert.equal(checkFile(txt, IAB_MREC).verdict, 'fail');
  const broken = await probe(mk.file([0, 0, 0, 16, ...'ftypisom'.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0], 'v.mp4'));
  assert.match(broken.error, /video header/);
});

// ---------- rules ----------
test('passes a correct 300x250 image and accepts the 2x retina size', async () => {
  const ok = checkFile(await probe(mk.file(mk.png(300, 250), 'a.png')), IAB_MREC);
  assert.equal(ok.verdict, 'pass');
  const retina = checkFile(await probe(mk.file(mk.png(600, 500), 'a.png')), IAB_MREC);
  assert.equal(statusOf(retina, 'Size'), 'pass');
});

test('fails wrong size, wrong format, and overweight files', async () => {
  const wrong = checkFile(await probe(mk.file(mk.png(301, 250), 'a.png')), IAB_MREC);
  assert.equal(statusOf(wrong, 'Size'), 'fail');
  const webp = checkFile(await probe(mk.file(mk.webpVP8X(300, 250), 'a.webp')), IAB_MREC);
  assert.equal(statusOf(webp, 'File format'), 'fail');
  const heavy = checkFile({ ...(await probe(mk.file(mk.png(300, 250), 'a.png'))), sizeBytes: 151 * 1024 }, IAB_MREC);
  assert.equal(statusOf(heavy, 'Max file size'), 'fail');
  const edge = checkFile({ ...(await probe(mk.file(mk.png(300, 250), 'a.png'))), sizeBytes: 150 * 1024 }, IAB_MREC);
  assert.equal(statusOf(edge, 'Max file size'), 'pass');
});

test('blocks animation where only static images are allowed', async () => {
  const staticOnly = { ...IAB_MREC, creative_types: ['image'] };
  const res = checkFile(await probe(mk.file(mk.gif(300, 250, 4), 'a.gif')), staticOnly);
  assert.equal(statusOf(res, 'Creative type'), 'fail');
});

test('skips checks the spec has not filled in yet, instead of guessing', async () => {
  const pending = { creative_types: ['image'], dimensions: [{ width: 300, height: 250 }], file: { formats: ['png'], max_size_kb: null } };
  const res = checkFile(await probe(mk.file(mk.png(300, 250), 'a.png')), pending);
  assert.equal(statusOf(res, 'Max file size'), 'skip');
  assert.equal(res.verdict, 'pass');
});

test('checks CTV video duration, codecs, and frame rate', async () => {
  const good = checkFile(await probe(mk.file(mk.mp4({ seconds: 15, fps: 29.97 }), 'v.mp4')), CTV);
  assert.equal(statusOf(good, 'Duration'), 'pass');
  assert.equal(statusOf(good, 'Frame rate'), 'pass');
  const long = checkFile(await probe(mk.file(mk.mp4({ seconds: 31 }), 'v.mp4')), CTV);
  assert.equal(statusOf(long, 'Duration'), 'fail');
  const tolerance = checkFile(await probe(mk.file(mk.mp4({ seconds: 30.4 }), 'v.mp4')), CTV);
  assert.equal(statusOf(tolerance, 'Duration'), 'pass');
  const hevc = checkFile(await probe(mk.file(mk.mp4({ video: 'hvc1' }), 'v.mp4')), CTV);
  assert.equal(statusOf(hevc, 'Video codec'), 'fail');
  const silent = checkFile(await probe(mk.file(mk.mp4({ audio: null }), 'v.mp4')), CTV);
  assert.equal(statusOf(silent, 'Audio codec'), 'warn');
  const pal = checkFile(await probe(mk.file(mk.mp4({ fps: 25 }), 'v.mp4')), CTV);
  assert.equal(statusOf(pal, 'Frame rate'), 'fail');
});

test('treats a bigger same-shape video as a warning, a different shape as a failure', async () => {
  const uhd = checkFile(await probe(mk.file(mk.mp4({ w: 3840, h: 2160 }), 'v.mp4')), CTV);
  assert.equal(statusOf(uhd, 'Size'), 'warn');
  const vertical = checkFile(await probe(mk.file(mk.mp4({ w: 1080, h: 1920 }), 'v.mp4')), CTV);
  assert.equal(statusOf(vertical, 'Size'), 'fail');
});

test('checks duration ranges and aspect-ratio-only specs', async () => {
  const social = { creative_types: ['video'], aspect_ratios: ['9:16', '1:1'], file: { formats: ['mp4'] }, video: { min_duration_s: 5, max_duration_s: 60 } };
  const ok = checkFile(await probe(mk.file(mk.mp4({ w: 1080, h: 1920, seconds: 20 }), 'v.mp4')), social);
  assert.equal(statusOf(ok, 'Aspect ratio'), 'pass'); assert.equal(statusOf(ok, 'Duration'), 'pass');
  const short = checkFile(await probe(mk.file(mk.mp4({ w: 1080, h: 1080, seconds: 3 }), 'v.mp4')), social);
  assert.equal(statusOf(short, 'Duration'), 'fail');
  const landscape = checkFile(await probe(mk.file(mk.mp4({ w: 1920, h: 1080, seconds: 10 }), 'v.mp4')), social);
  assert.equal(statusOf(landscape, 'Aspect ratio'), 'fail');
});

test('flags HTML5 problems ad servers reject', async () => {
  const bad = checkFile(await probe(mk.file(mk.zip([['ad/main.html', '<script src="https://cdn.x.com/a.js"></script>']]), 'ad.zip')), IAB_MREC);
  assert.equal(statusOf(bad, 'clickTag'), 'warn');
  assert.equal(statusOf(bad, 'External files'), 'warn');
  assert.equal(statusOf(bad, 'Size'), 'warn');
  assert.equal(statusOf(bad, 'Entry page'), 'warn');
  const none = checkFile(await probe(mk.file(mk.zip([['img.jpg', 'x']]), 'ad.zip')), IAB_MREC);
  assert.equal(statusOf(none, 'Entry page'), 'fail');
  const wrongSize = checkFile(await probe(mk.file(mk.zip([['index.html', '<meta name="ad.size" content="width=728,height=90">clickTag']]), 'ad.zip')), IAB_MREC);
  assert.equal(statusOf(wrongSize, 'Size'), 'fail');
});

test('every result explains itself', async () => {
  const res = checkFile(await probe(mk.file(mk.mp4({ seconds: 31, video: 'hvc1', fps: 25 }), 'v.mp4')), CTV);
  for (const r of res.results) {
    assert.ok(r.rule && r.status && r.expected !== undefined && r.actual !== undefined, JSON.stringify(r));
    if (r.status === 'fail' || r.status === 'warn') assert.ok(r.fix && r.fix.length > 10, `no fix text for ${r.rule}`);
  }
});

test('validates every real spec file without throwing', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../data/specs/', import.meta.url);
  const samples = [mk.png(300, 250), mk.gif(300, 250, 2), mk.mp4(), mk.zip([['index.html', 'clickTag']])];
  for (const plat of readdirSync(dir)) {
    for (const f of readdirSync(new URL(`${plat}/`, dir))) {
      const spec = JSON.parse(readFileSync(new URL(`${plat}/${f}`, dir)));
      for (const s of samples) {
        const res = checkFile(await probe(mk.file(s, 'x')), spec);
        assert.ok(['pass', 'warn', 'fail'].includes(res.verdict));
      }
    }
  }
});
