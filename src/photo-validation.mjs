import { crc32, inflateSync } from 'node:zlib';

export const photoLimit = 2 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxChunks = 2048;
const maxDimension = 16384;
const maxPixels = 16 * 1024 * 1024;
const maxDecodedBytes = 64 * 1024 * 1024;
const pngDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const pngChannels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const frameMarkers = new Set([0xc0, 0xc1, 0xc2]);

function invalid(code = 'PHOTO_INVALID') {
  throw Object.assign(new Error('照片无法读取，请另存为 JPG 或 PNG 后重试。'), { code });
}

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width > maxDimension || height > maxDimension || width * height > maxPixels) invalid('PHOTO_DIMENSIONS');
}

function pngPixels(header, compressed, transparentPalette) {
  const { width, height, bits, color, interlace } = header;
  // The downstream decoder does not correctly handle packed transparent/interlaced pixels.
  if (bits < 8 && (interlace || transparentPalette)) invalid();
  if (interlace && (width < 8 || height < 8)) invalid();
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    const h = Math.max(0, Math.ceil((height - y) / dy));
    return { length: 1 + Math.ceil(w * bits * pngChannels[color] / 8), count: w ? h : 0 };
  });
  const expected = rows.reduce((size, row) => size + row.length * row.count, 0);
  if (expected > maxDecodedBytes) invalid('PHOTO_DIMENSIONS');
  // Bound and validate decompression before PDFKit's asynchronous PNG decoder sees the image.
  const data = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (data.length !== expected) invalid();
  let offset = 0;
  for (const row of rows) for (let index = 0; index < row.count; index++, offset += row.length) {
    if (data[offset] > 4) invalid();
  }
}

function inspectPng(data) {
  let offset = 8, count = 0, header = null, palette = 0, transparency = false;
  let sawData = false, closedData = false, complete = false;
  const compressed = [], renderChunks = [pngSignature];
  while (offset < data.length) {
    if (++count > maxChunks || data.length - offset < 12) invalid();
    const length = data.readUInt32BE(offset);
    // Use unsigned lengths and prove forward progress before invoking any third-party parser.
    if (length > 0x7fffffff || length > data.length - offset - 12) invalid();
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) invalid();
    const end = offset + 12 + length;
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) invalid();
    const bytes = data.subarray(offset + 8, end - 4);
    if (count === 1 && type !== 'IHDR') invalid();
    if (sawData && type !== 'IDAT') closedData = true;
    if (type === 'IHDR') {
      if (header || count !== 1 || length !== 13) invalid();
      header = { width: bytes.readUInt32BE(0), height: bytes.readUInt32BE(4), bits: bytes[8],
        color: bytes[9], interlace: bytes[12] };
      dimensions(header.width, header.height);
      if (!pngDepths[header.color]?.includes(header.bits) || bytes[10] || bytes[11] || header.interlace > 1) invalid();
    } else if (type === 'PLTE') {
      if (!header || palette || transparency || sawData || !length || length > 768 || length % 3 || [0, 4].includes(header.color)) invalid();
      palette = length / 3;
      if (header.color === 3 && palette > 2 ** header.bits) invalid();
    } else if (type === 'tRNS') {
      if (!header || transparency || sawData || !length || [4, 6].includes(header.color)) invalid();
      if ((header.color === 0 && length !== 2) || (header.color === 2 && length !== 6)
        || (header.color === 3 && (!palette || length > palette))) invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (!header || closedData || (header.color === 3 && !palette)) invalid();
      compressed.push(bytes); sawData = true;
    } else if (type === 'IEND') {
      if (length || !sawData || end !== data.length) invalid();
      complete = true;
    } else if (type[0] === type[0].toUpperCase()) invalid();
    // PDFKit need not parse PNG text metadata; removing it avoids its unbounded string-argument conversion.
    if (type !== 'tEXt') renderChunks.push(data.subarray(offset, end));
    offset = end;
    if (complete) break;
  }
  if (!complete || !header || !compressed.some(bytes => bytes.length)) invalid();
  pngPixels(header, compressed, header.color === 3 && transparency);
  return { mime: 'image/png', type: 'png', width: header.width, height: header.height,
    data: Buffer.concat(renderChunks) };
}

function inspectJpeg(data) {
  let offset = 2, count = 0, frame = null, sawScan = false, sawPixels = false;
  while (offset < data.length) {
    if (++count > maxChunks || data[offset++] !== 0xff) invalid();
    while (data[offset] === 0xff) offset++;
    if (offset >= data.length) invalid();
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!frame || !sawScan || !sawPixels || offset !== data.length) invalid();
      return { ...frame, mime: 'image/jpeg', type: 'jpg', data };
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)
      || offset + 2 > data.length) invalid();
    const length = data.readUInt16BE(offset);
    if (length < 2 || length > data.length - offset) invalid();
    const end = offset + length;
    if (frameMarkers.has(marker)) {
      if (frame || length < 8 || data[offset + 2] !== 8) invalid();
      frame = { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      const components = data[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
      dimensions(frame.width, frame.height);
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xcc].includes(marker)) invalid();
    offset = end;
    if (marker !== 0xda) continue;
    if (!frame || length < 8) invalid();
    sawScan = true;
    // Walk stuffed data and restart markers with a strict input bound; subsequent scans remain valid.
    while (offset < data.length) {
      if (data[offset] !== 0xff) { sawPixels = true; offset++; continue; }
      if (offset + 1 >= data.length) invalid();
      if (data[offset + 1] === 0 || (data[offset + 1] >= 0xd0 && data[offset + 1] <= 0xd7)) {
        sawPixels = true; offset += 2; continue;
      }
      break;
    }
  }
  invalid();
}

/** Only bounded, structurally validated images may reach PDFKit/png-js. */
export function inspectPhoto(value, { mime } = {}) {
  if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > photoLimit) invalid();
  const data = Buffer.from(value);
  let result;
  if (data.subarray(0, 8).equals(pngSignature)) result = inspectPng(data);
  else if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) result = inspectJpeg(data);
  else invalid();
  if (mime && mime !== result.mime) invalid();
  return result;
}
