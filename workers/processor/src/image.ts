// Reads image dimensions from the file header. Pure, so it can be tested outside the Worker runtime.
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);

export type Info = { w: number; h: number; mime: string };
// "need_more": the header continues past the bytes supplied (e.g. large JPEG metadata); read at least `needed` bytes and retry.
export type Inspect = ({ status: "ok" } & Info) | { status: "need_more"; needed: number } | { status: "invalid" };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function inspect(b: Uint8Array): Inspect {
  if (b.length < 30) return { status: "invalid" }; // too short to hold any header
  if (PNG_SIG.every((v, i) => b[i] === v)) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return { status: "invalid" };
    return { status: "ok", w: dv.getUint32(16), h: dv.getUint32(20), mime: "image/png" };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (true) {
      if (i + 4 > b.length) return { status: "need_more", needed: i + 4 };
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; } // fill byte
      if (m === 0xd9 || m === 0xda) return { status: "invalid" }; // end of image / scan reached with no frame header
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // markers without a length
      const len = u16(b, i + 2);
      if (len < 2) return { status: "invalid" };
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return { status: "need_more", needed: i + 9 };
        return { status: "ok", h: u16(b, i + 5), w: u16(b, i + 7), mime: "image/jpeg" };
      }
      i += 2 + len; // skip a whole segment, however large (EXIF, ICC, XMP)
    }
  }
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) === "RIFF" && tag(8) === "WEBP") {
    const c = tag(12);
    if (c === "VP8 ") return { status: "ok", w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff, mime: "image/webp" };
    if (c === "VP8L") return { status: "ok", w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)), mime: "image/webp" };
    if (c === "VP8X") return { status: "ok", w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), mime: "image/webp" };
  }
  return { status: "invalid" };
}

// Backwards-compatible helper: dimensions from the bytes given, or null if unreadable or incomplete.
export function dimensions(b: Uint8Array): Info | null {
  const r = inspect(b);
  return r.status === "ok" ? { w: r.w, h: r.h, mime: r.mime } : null;
}
