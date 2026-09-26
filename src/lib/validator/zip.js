// Reads a ZIP's central directory to inspect an HTML5 ad package without
// unpacking it. Uses the platform DecompressionStream for index.html only.

export function listZip(buffer) {
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count && off + 46 <= view.byteLength; n++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const compressed = view.getUint32(off + 20, true);
    const size = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const local = view.getUint32(off + 42, true);
    const name = dec.decode(new Uint8Array(buffer, off + 46, nameLen));
    if (!name.endsWith('/')) entries.push({ name, method, compressed, size, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readZipText(buffer, entry) {
  const view = new DataView(buffer);
  const nameLen = view.getUint16(entry.local + 26, true);
  const extraLen = view.getUint16(entry.local + 28, true);
  const start = entry.local + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, entry.compressed);
  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) return null;
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

/** Summarize an HTML5 ad zip the way ad servers look at it. */
export async function inspectHtml5Zip(buffer) {
  const entries = listZip(buffer);
  if (!entries) return null;
  const index = entries.find((e) => /(^|\/)index\.html?$/i.test(e.name)) ?? entries.find((e) => /\.html?$/i.test(e.name));
  let html = null;
  if (index) { try { html = await readZipText(buffer, index); } catch { html = null; } }
  const sizeMatch = html && html.match(/<meta[^>]+name=["']ad\.size["'][^>]+content=["']width=(\d+),\s*height=(\d+)/i);
  return {
    fileCount: entries.length,
    uncompressedBytes: entries.reduce((a, e) => a + e.size, 0),
    hasHtml: Boolean(index),
    htmlName: index?.name ?? null,
    hasClickTag: html ? /clicktag/i.test(html) : false,
    declaredWidth: sizeMatch ? Number(sizeMatch[1]) : null,
    declaredHeight: sizeMatch ? Number(sizeMatch[2]) : null,
    externalRequests: html ? (html.match(/(?:src|href)=["']https?:\/\//gi) || []).length : 0,
  };
}
