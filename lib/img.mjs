/**
 * lib/img.mjs —— 图片尺寸解析（不依赖任何原生库）
 */
export function imageSize(buf) {
  try {
    // PNG
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png', ext: 'png' }
    }
    // JPEG：找 SOF0/SOF2
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), mime: 'image/jpeg', ext: 'jpg' }
        }
        const len = buf.readUInt16BE(i + 2)
        i += 2 + len
      }
    }
    // WebP：VP8X / 有损 VP8 / 无损 VP8L
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3)
        const h = 1 + buf.readUIntLE(27, 3)
        return { width: w, height: h, mime: 'image/webp', ext: 'webp' }
      }
      if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
        const w = 1 + (b0 | ((b1 & 0x3f) << 8))
        const h = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10))
        return { width: w, height: h, mime: 'image/webp', ext: 'webp' }
      }
      if (chunk === 'VP8 ' && buf.length >= 30) {
        const start = buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a
        if (start) {
          const w = buf.readUInt16LE(26) & 0x3fff
          const h = buf.readUInt16LE(28) & 0x3fff
          return { width: w, height: h, mime: 'image/webp', ext: 'webp' }
        }
      }
    }
  } catch {}
  return { width: 0, height: 0, mime: 'application/octet-stream', ext: 'bin' }
}

/** 目标宽度：<=1.65MP、宽度对齐 14 */
export function fitWidth(width, height, maxPixels = 1_650_000) {
  if (!width || !height) return 0
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  let w = Math.floor(width * scale)
  w = w - (w % 14)
  return Math.max(14, w)
}
