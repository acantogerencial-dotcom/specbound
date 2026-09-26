// Minimal ISO-BMFF / QuickTime reader. Reads only the boxes needed to check a
// video ad against a spec: duration, frame size, codecs, frame rate.
// Works on MP4 and MOV. Never decodes media, so it's fast and dependency-free.

const CODEC_NAMES = {
  avc1: 'H.264', avc3: 'H.264', hvc1: 'H.265', hev1: 'H.265', vp09: 'VP9', av01: 'AV1',
  apcn: 'ProRes 422', apch: 'ProRes 422 HQ', apcs: 'ProRes 422 LT', apco: 'ProRes 422 Proxy', ap4h: 'ProRes 4444',
  mp4v: 'MPEG-4 Visual', mp4a: 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', lpcm: 'PCM',
  sowt: 'PCM', twos: 'PCM', 'in24': 'PCM', 'in32': 'PCM', fl32: 'PCM', '.mp3': 'MP3',
};

function fourcc(view, off) {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

function* boxes(view, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = fourcc(view, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) return;
    yield { type, start: off, body: off + header, end: off + size };
    off += size;
  }
}

function find(view, parent, type) {
  for (const b of boxes(view, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

function readTrak(view, trak) {
  const t = {};
  const tkhd = find(view, trak, 'tkhd');
  if (tkhd) {
    const v = view.getUint8(tkhd.body);
    const wOff = tkhd.body + (v === 1 ? 88 : 76);
    if (wOff + 8 <= tkhd.end) {
      t.width = Math.round(view.getUint32(wOff) / 65536);
      t.height = Math.round(view.getUint32(wOff + 4) / 65536);
    }
  }
  const mdia = find(view, trak, 'mdia');
  if (!mdia) return t;
  const hdlr = find(view, mdia, 'hdlr');
  if (hdlr) t.handler = fourcc(view, hdlr.body + 8);
  const mdhd = find(view, mdia, 'mdhd');
  if (mdhd) {
    const v = view.getUint8(mdhd.body);
    t.timescale = view.getUint32(mdhd.body + (v === 1 ? 20 : 12));
    t.duration = v === 1 ? Number(view.getBigUint64(mdhd.body + 24)) : view.getUint32(mdhd.body + 16);
  }
  const minf = find(view, mdia, 'minf');
  const stbl = minf && find(view, minf, 'stbl');
  if (stbl) {
    const stsd = find(view, stbl, 'stsd');
    if (stsd && view.getUint32(stsd.body + 4) > 0) {
      const entry = stsd.body + 8;
      t.codecTag = fourcc(view, entry + 4);
      if (t.handler === 'vide' && entry + 36 <= stsd.end) {
        t.sampleWidth = view.getUint16(entry + 32);
        t.sampleHeight = view.getUint16(entry + 34);
      }
    }
    const stts = find(view, stbl, 'stts');
    if (stts) {
      const n = view.getUint32(stts.body + 4);
      let samples = 0;
      for (let i = 0; i < n; i++) samples += view.getUint32(stts.body + 8 + i * 8);
      t.sampleCount = samples;
    }
  }
  return t;
}

/** Parse the header of an MP4/MOV file. Pass the whole file or at least the part holding `moov`. */
export function parseMp4(buffer) {
  const view = new DataView(buffer);
  let ftyp = null, moov = null;
  for (const b of boxes(view, 0, view.byteLength)) {
    if (b.type === 'ftyp') ftyp = fourcc(view, b.body);
    if (b.type === 'moov') moov = b;
  }
  if (!moov) return null;
  const out = { brand: ftyp, container: ftyp === 'qt  ' ? 'mov' : 'mp4' };
  const mvhd = find(view, moov, 'mvhd');
  if (mvhd) {
    const v = view.getUint8(mvhd.body);
    const ts = view.getUint32(mvhd.body + (v === 1 ? 20 : 12));
    const d = v === 1 ? Number(view.getBigUint64(mvhd.body + 24)) : view.getUint32(mvhd.body + 16);
    if (ts) out.durationS = d / ts;
  }
  for (const b of boxes(view, moov.body, moov.end)) {
    if (b.type !== 'trak') continue;
    const t = readTrak(view, b);
    if (t.handler === 'vide' && !out.videoCodec) {
      out.videoCodec = CODEC_NAMES[t.codecTag] ?? t.codecTag;
      out.width = t.width || t.sampleWidth;
      out.height = t.height || t.sampleHeight;
      if (t.timescale && t.duration && t.sampleCount) {
        const trackS = t.duration / t.timescale;
        out.fps = Math.round((t.sampleCount / trackS) * 100) / 100;
        out.durationS ??= trackS;
      }
    }
    if (t.handler === 'soun' && !out.audioCodec) out.audioCodec = CODEC_NAMES[t.codecTag] ?? t.codecTag;
  }
  return out;
}
