// Turns a File (or Blob with a name) into plain metadata. Runs in the browser
// and in Node 20+, so the same code is covered by tests. Nothing is uploaded.
import { parseMp4 } from './mp4.js';
import { inspectHtml5Zip } from './zip.js';

const u8 = (buf) => new Uint8Array(buf);
const ascii = (b, s, n) => String.fromCharCode(...b.slice(s, s + n));

export function sniff(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 3) === 'GIF') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  const t = ascii(b, 4, 4);
  if (t === 'ftyp') return ascii(b, 8, 4) === 'qt  ' ? 'mov' : 'mp4';
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(t)) return 'mov';
  return null;
}

/** Width/height (and animation) straight from image headers, no decoding. */
export function imageInfo(buffer, format) {
  const b = u8(buffer);
  const v = new DataView(buffer);
  if (format === 'png') {
    let animated = false;
    for (let off = 8; off + 8 < b.length; ) {
      const len = v.getUint32(off);
      const type = ascii(b, off + 4, 4);
      if (type === 'acTL') { animated = true; break; }
      if (type === 'IDAT') break;
      off += 12 + len;
    }
    return { width: v.getUint32(16), height: v.getUint32(20), animated };
  }
  if (format === 'gif') {
    let frames = 0;
    for (let i = 13; i < b.length - 1; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
    return { width: v.getUint16(6, true), height: v.getUint16(8, true), animated: frames > 1 };
  }
  if (format === 'webp') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), animated: (b[20] & 0x02) !== 0 };
    if (chunk === 'VP8L') { const bits = v.getUint32(21, true); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false }; }
    if (chunk === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff, animated: false };
    return {};
  }
  if (format === 'jpg') {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const marker = b[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = v.getUint16(off + 2);
      if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: v.getUint16(off + 7), height: v.getUint16(off + 5), animated: false };
      }
      off += 2 + len;
    }
  }
  return {};
}

// Find `moov` without reading a whole (possibly 1 GB) video into memory.
async function readMoov(file) {
  let off = 0;
  const size = file.size;
  let ftyp = null;
  while (off + 8 <= size) {
    const head = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let boxSize = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (boxSize === 1) boxSize = Number(head.getBigUint64(8));
    else if (boxSize === 0) boxSize = size - off;
    if (boxSize < 8) return null;
    if (type === 'ftyp') ftyp = await file.slice(off, off + boxSize).arrayBuffer();
    if (type === 'moov') {
      const moov = await file.slice(off, off + boxSize).arrayBuffer();
      if (!ftyp) return moov;
      const joined = new Uint8Array(ftyp.byteLength + moov.byteLength);
      joined.set(new Uint8Array(ftyp), 0);
      joined.set(new Uint8Array(moov), ftyp.byteLength);
      return joined.buffer;
    }
    off += boxSize;
  }
  return null;
}

export async function probe(file) {
  const name = file.name ?? 'file';
  const head = u8(await file.slice(0, 32).arrayBuffer());
  const format = sniff(head);
  const meta = { name, sizeBytes: file.size, format, kind: null };
  if (!format) { meta.error = 'Unrecognized file type. Use JPG, PNG, GIF, WebP, MP4, MOV, or an HTML5 .zip.'; return meta; }

  if (['jpg', 'png', 'gif', 'webp'].includes(format)) {
    const info = imageInfo(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer(), format);
    Object.assign(meta, { width: info.width, height: info.height, kind: info.animated ? 'animated-image' : 'image' });
  } else if (format === 'mp4' || format === 'mov') {
    meta.kind = 'video';
    const moov = await readMoov(file);
    const info = moov && parseMp4(moov);
    if (!info) { meta.error = 'Could not read the video header. The file may be damaged or still uploading.'; return meta; }
    Object.assign(meta, {
      container: format, width: info.width, height: info.height, durationS: info.durationS,
      videoCodec: info.videoCodec ?? null, audioCodec: info.audioCodec ?? null, fps: info.fps ?? null,
    });
    if (info.durationS) meta.bitrateKbps = Math.round((file.size * 8) / info.durationS / 1000);
  } else if (format === 'zip') {
    meta.kind = 'html5';
    const z = await inspectHtml5Zip(await file.arrayBuffer());
    if (!z) { meta.error = 'This zip could not be read.'; return meta; }
    Object.assign(meta, z, { width: z.declaredWidth, height: z.declaredHeight });
  }
  return meta;
}
