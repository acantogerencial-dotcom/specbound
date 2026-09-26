// Builders for tiny synthetic ad files, so tests run anywhere with no fixtures.
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le16 = (n) => [n & 255, (n >>> 8) & 255];
const str = (s) => [...s].map((c) => c.charCodeAt(0));
const zeros = (n) => new Array(n).fill(0);

export const file = (bytes, name) => new File([new Uint8Array(bytes)], name);

export function png(w, h, { animated = false } = {}) {
  const chunk = (type, data) => [...be32(data.length), ...str(type), ...data, 0, 0, 0, 0];
  return [0x89, ...str('PNG'), 13, 10, 26, 10, ...chunk('IHDR', [...be32(w), ...be32(h), 8, 2, 0, 0, 0]), ...(animated ? chunk('acTL', [...be32(3), ...be32(0)]) : []), ...chunk('IDAT', [0]), ...chunk('IEND', [])];
}
export function gif(w, h, frames = 1) {
  const gce = [0x21, 0xf9, 4, 0, 10, 0, 0, 0];
  const frame = [...gce, 0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0];
  return [...str('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0, ...Array.from({ length: frames }, () => frame).flat(), 0x3b];
}
export function jpg(w, h) {
  return [0xff, 0xd8, 0xff, 0xe0, 0, 16, ...str('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
}
export function webpVP8X(w, h, animated = false) {
  const body = [animated ? 0x02 : 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255];
  return [...str('RIFF'), ...le32(4 + 8 + body.length), ...str('WEBP'), ...str('VP8X'), ...le32(body.length), ...body];
}

// Stored (uncompressed) zip. entries: [[name, text]]
export function zip(entries) {
  const enc = new TextEncoder();
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = [...enc.encode(name)], d = [...enc.encode(text)];
    const lh = [...le32(0x04034b50), ...le16(20), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(d.length), ...le32(d.length), ...le16(n.length), 0, 0, ...n, ...d];
    central.push(...le32(0x02014b50), ...le16(20), ...le16(20), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(d.length), ...le32(d.length), ...le16(n.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le32(offset), ...n);
    local.push(...lh);
    offset += lh.length;
  }
  const eocd = [...le32(0x06054b50), 0, 0, 0, 0, ...le16(entries.length), ...le16(entries.length), ...le32(central.length), ...le32(offset), 0, 0];
  return [...local, ...central, ...eocd];
}

// ISO-BMFF builder
const box = (type, ...kids) => { const body = kids.flat(); return [...be32(8 + body.length), ...str(type), ...body]; };
function trak({ handler, codec, w = 0, h = 0, timescale, duration, samples }) {
  const tkhd = box('tkhd', [0, 0, 0, 3], zeros(72), be32(w * 65536), be32(h * 65536));
  const mdhd = box('mdhd', [0, 0, 0, 0], zeros(8), be32(timescale), be32(duration), zeros(4));
  const hdlr = box('hdlr', [0, 0, 0, 0], zeros(4), str(handler), zeros(12), [0]);
  const entry = handler === 'vide'
    ? [...be32(86), ...str(codec), ...zeros(24), ...be16(w), ...be16(h), ...zeros(50)]
    : [...be32(36), ...str(codec), ...zeros(28)];
  const stsd = box('stsd', [0, 0, 0, 0], be32(1), entry);
  const stts = box('stts', [0, 0, 0, 0], be32(1), be32(samples), be32(Math.round(duration / samples)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stts))));
}
export function mp4({ brand = 'isom', w = 1920, h = 1080, seconds = 15, fps = 30, video = 'avc1', audio = 'mp4a', moovAtEnd = false, mdatBytes = 64 } = {}) {
  const ts = 90000;
  const mvhd = box('mvhd', [0, 0, 0, 0], zeros(8), be32(1000), be32(Math.round(seconds * 1000)), zeros(80));
  const traks = [trak({ handler: 'vide', codec: video, w, h, timescale: ts, duration: Math.round(seconds * ts), samples: Math.round(seconds * fps) })];
  if (audio) traks.push(trak({ handler: 'soun', codec: audio, timescale: 48000, duration: seconds * 48000, samples: Math.round((seconds * 48000) / 1024) }));
  const moov = box('moov', mvhd, ...traks);
  const ftyp = box('ftyp', str(brand), be32(0), str(brand));
  const mdat = box('mdat', zeros(mdatBytes));
  return moovAtEnd ? [...ftyp, ...mdat, ...moov] : [...ftyp, ...moov, ...mdat];
}
