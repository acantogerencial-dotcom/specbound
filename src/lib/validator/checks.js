// Compares probed file metadata against one spec. Pure function, no I/O.
// Every result says what was expected, what was found, and what to do.

const DURATION_TOLERANCE_S = 0.5;
const FPS_TOLERANCE = 0.1;
const RATIO_TOLERANCE = 0.01;

const norm = (f) => String(f).toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
const fmtKb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${(bytes / 1024).toFixed(1)} KB`);
const limitKb = (kb) => (kb >= 1024 ? `${+(kb / 1024).toFixed(2)} MB` : `${kb} KB`);
const secs = (s) => `${Math.round(s * 100) / 100}s`;

const pass = (rule, expected, actual) => ({ rule, status: 'pass', expected, actual });
const fail = (rule, expected, actual, fix) => ({ rule, status: 'fail', expected, actual, fix });
const warn = (rule, expected, actual, fix) => ({ rule, status: 'warn', expected, actual, fix });
const skip = (rule, why) => ({ rule, status: 'skip', expected: '—', actual: '—', fix: why });

const PENDING = 'This value is not in the spec yet, so it was not checked.';

export function checkFile(meta, spec) {
  const r = [];
  if (meta.error) return { verdict: 'fail', results: [fail('File', 'A readable ad file', 'Unreadable', meta.error)] };

  // Creative type
  const types = spec.creative_types ?? [];
  if (types.includes(meta.kind)) r.push(pass('Creative type', types.join(', '), meta.kind));
  else if (meta.kind === 'animated-image' && types.includes('image')) r.push(fail('Creative type', types.join(', '), 'animated image', 'This placement takes static images. Export a single-frame file.'));
  else r.push(fail('Creative type', types.join(', '), meta.kind, `This placement doesn't accept ${meta.kind} files.`));

  // Format
  const formats = (spec.file?.formats ?? []).map(norm);
  const containers = (spec.video?.containers ?? []).map(norm);
  const accepted = meta.kind === 'video' && containers.length ? containers : formats;
  const actualFmt = meta.format === 'zip' ? 'zip' : meta.format;
  if (!accepted.length) r.push(skip('File format', PENDING));
  else if (accepted.includes(actualFmt) || (actualFmt === 'zip' && accepted.includes('html5'))) r.push(pass('File format', accepted.join(', '), actualFmt));
  else r.push(fail('File format', accepted.join(', '), actualFmt, `Re-export as ${accepted.filter((f) => f !== 'html5').join(' or ') || 'an HTML5 zip'}.`));

  // Dimensions
  const dims = spec.dimensions ?? [];
  const ratios = spec.aspect_ratios ?? [];
  const got = meta.width && meta.height ? `${meta.width}×${meta.height}` : 'unknown';
  if (!meta.width || !meta.height) {
    r.push(meta.kind === 'html5'
      ? warn('Size', dims.map((d) => `${d.width}×${d.height}`).join(' or ') || '—', 'not declared', 'Add <meta name="ad.size" content="width=…,height=…"> to index.html so ad servers know the size.')
      : fail('Size', dims.map((d) => `${d.width}×${d.height}`).join(' or ') || '—', got, 'The file size could not be read.'));
  } else if (dims.length) {
    const hit = dims.find((d) => d.width === meta.width && d.height === meta.height);
    const expected = dims.map((d) => `${d.width}×${d.height}`).join(' or ');
    if (hit) r.push(pass('Size', expected, `${got}${hit.label ? ` (${hit.label})` : ''}`));
    else {
      const sameShape = dims.find((d) => Math.abs(d.width / d.height - meta.width / meta.height) / (d.width / d.height) < RATIO_TOLERANCE);
      if (sameShape && meta.kind === 'video' && meta.width >= sameShape.width) r.push(warn('Size', expected, got, `Same shape as ${sameShape.width}×${sameShape.height}. Most players rescale this, but export at the exact size to be safe.`));
      else r.push(fail('Size', expected, got, `Resize to ${expected}.`));
    }
  } else if (ratios.length) {
    const actual = meta.width / meta.height;
    const hit = ratios.find((q) => { const [a, b] = q.split(':').map(Number); return Math.abs(a / b - actual) / (a / b) < RATIO_TOLERANCE; });
    if (hit) r.push(pass('Aspect ratio', ratios.join(', '), `${got} (${hit})`));
    else r.push(fail('Aspect ratio', ratios.join(', '), got, `Crop to ${ratios.join(' or ')}.`));
  } else r.push(skip('Size', PENDING));

  // File weight
  const max = spec.file?.max_size_kb;
  if (max == null) r.push(skip('Max file size', PENDING));
  else if (meta.sizeBytes <= max * 1024) r.push(pass('Max file size', `≤ ${limitKb(max)}`, fmtKb(meta.sizeBytes)));
  else r.push(fail('Max file size', `≤ ${limitKb(max)}`, fmtKb(meta.sizeBytes), `Cut ${fmtKb(meta.sizeBytes - max * 1024)}. Compress images or lower the bitrate.`));

  // HTML5
  if (meta.kind === 'html5') {
    const il = spec.file?.initial_load_kb;
    if (il == null) r.push(skip('Initial load', PENDING));
    else if (meta.sizeBytes <= il * 1024) r.push(pass('Initial load', `≤ ${limitKb(il)}`, `${fmtKb(meta.sizeBytes)} zipped`));
    else r.push(fail('Initial load', `≤ ${limitKb(il)}`, `${fmtKb(meta.sizeBytes)} zipped`, 'Move heavy assets into a polite subload or compress them.'));
    if (!meta.hasHtml) r.push(fail('Entry page', 'index.html at the zip root', 'missing', 'Put index.html at the root of the zip.'));
    else if (/^index\.html?$/i.test(meta.htmlName)) r.push(pass('Entry page', 'index.html at the zip root', meta.htmlName));
    else r.push(warn('Entry page', 'index.html at the zip root', meta.htmlName, 'Rename the main page to index.html and zip the files themselves, not their folder.'));
    r.push(meta.hasClickTag ? pass('clickTag', 'present', 'present') : warn('clickTag', 'present', 'not found', 'Most ad servers need a clickTag variable for click tracking.'));
    if (meta.externalRequests > 0) r.push(warn('External files', 'none', `${meta.externalRequests} found`, 'Bundle scripts, images, and fonts inside the zip. Many ad servers block outside requests.'));
  }

  // Video
  if (meta.kind === 'video') {
    const v = spec.video ?? {};
    const d = meta.durationS;
    if (d == null) r.push(fail('Duration', '—', 'unknown', 'The duration could not be read.'));
    else if (v.allowed_durations_s?.length) {
      const hit = v.allowed_durations_s.find((a) => Math.abs(a - d) <= DURATION_TOLERANCE_S);
      const exp = v.allowed_durations_s.map(secs).join(' or ');
      r.push(hit != null ? pass('Duration', exp, secs(d)) : fail('Duration', exp, secs(d), `Trim to exactly ${exp}.`));
    } else if (v.min_duration_s != null || v.max_duration_s != null) {
      const exp = `${v.min_duration_s != null ? secs(v.min_duration_s) : 'any'} to ${v.max_duration_s != null ? secs(v.max_duration_s) : 'any'}`;
      if (v.max_duration_s != null && d > v.max_duration_s + 0.05) r.push(fail('Duration', exp, secs(d), `Trim by ${secs(d - v.max_duration_s)}.`));
      else if (v.min_duration_s != null && d < v.min_duration_s - 0.05) r.push(fail('Duration', exp, secs(d), `Needs ${secs(v.min_duration_s - d)} more.`));
      else r.push(pass('Duration', exp, secs(d)));
    } else r.push(skip('Duration', PENDING));

    const codecCheck = (rule, list, actual) => {
      if (!list?.length) return r.push(skip(rule, PENDING));
      if (!actual) return r.push(warn(rule, list.join(', '), 'none found', rule === 'Audio codec' ? 'No audio track. Some platforms require a silent track.' : 'No video track found.'));
      const ok = list.some((c) => actual.toLowerCase().startsWith(String(c).toLowerCase().replace('avc', 'h.264').replace('hevc', 'h.265')) || String(c).toLowerCase() === actual.toLowerCase());
      r.push(ok ? pass(rule, list.join(', '), actual) : fail(rule, list.join(', '), actual, `Re-encode with ${list[0]}.`));
    };
    codecCheck('Video codec', v.video_codecs, meta.videoCodec);
    codecCheck('Audio codec', v.audio_codecs, meta.audioCodec);

    if (v.min_bitrate_kbps == null && v.max_bitrate_kbps == null) r.push(skip('Bitrate', PENDING));
    else {
      const b = meta.bitrateKbps;
      const exp = `${v.min_bitrate_kbps ?? 'any'} to ${v.max_bitrate_kbps ?? 'any'} kbps`;
      if (v.min_bitrate_kbps != null && b < v.min_bitrate_kbps) r.push(fail('Bitrate', exp, `~${b} kbps`, 'Re-export at a higher bitrate.'));
      else if (v.max_bitrate_kbps != null && b > v.max_bitrate_kbps) r.push(fail('Bitrate', exp, `~${b} kbps`, 'Re-export at a lower bitrate.'));
      else r.push(pass('Bitrate', exp, `~${b} kbps`));
    }

    if (!v.frame_rates?.length) r.push(skip('Frame rate', PENDING));
    else if (meta.fps == null) r.push(warn('Frame rate', v.frame_rates.join(', '), 'unknown', 'Frame rate could not be read.'));
    else {
      const ok = v.frame_rates.some((f) => Math.abs(f - meta.fps) <= FPS_TOLERANCE);
      r.push(ok ? pass('Frame rate', v.frame_rates.map((f) => `${f} fps`).join(', '), `${meta.fps} fps`) : fail('Frame rate', v.frame_rates.map((f) => `${f} fps`).join(', '), `${meta.fps} fps`, `Conform to ${v.frame_rates[0]} fps.`));
    }
    if (v.loudness_lufs != null) r.push(skip('Loudness', `Target ${v.loudness_lufs} LUFS. Loudness can't be measured in the browser yet; check it in your editor.`));
  }

  if (spec.safe_zone) r.push({ rule: 'Safe zone', status: 'info', expected: 'Keep text and logos clear', actual: '—', fix: 'Use the overlay preview to check that nothing important sits under the platform UI.' });

  const verdict = r.some((x) => x.status === 'fail') ? 'fail' : r.some((x) => x.status === 'warn') ? 'warn' : 'pass';
  return { verdict, results: r };
}
