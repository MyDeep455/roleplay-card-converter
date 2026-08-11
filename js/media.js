/* =========================================================================
 * MEDIA - card PNGs in, WebP data URLs out
 * =========================================================================
 * Two jobs:
 *
 * 1. Read the character card buried in a PNG. The V2/V3 card spec stores the
 *    whole JSON base64-encoded inside a tEXt chunk keyed `chara` (V2) or
 *    `ccv3` (V3), so pulling a card out means walking the PNG chunk table.
 *
 * 2. Re-encode every picture to a WebP data URL the same way Casual
 *    Character Chat does on its own imports, so a converted card weighs the
 *    same in IndexedDB as one imported by hand.
 * ========================================================================= */

// Matches the app: quality 0.80, gallery pictures capped at 1600px.
// Avatars are capped at 1024 here because bulk runs pull hundreds of them
// and a card PNG is often 1024x1536 to begin with.
const AVATAR_MAX_SIDE = 1024;
const GALLERY_MAX_SIDE = 1600;
const WEBP_QUALITY = 0.80;

/* ---------- PNG character-card extraction ---------- */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes) {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

// base64 -> UTF-8 string. atob yields one char per byte, so the bytes have to
// go back through TextDecoder or every non-ASCII character in the card
// (accents, CJK, emoji - very common in these cards) arrives mangled.
function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Pull the embedded character card out of a PNG ArrayBuffer.
 * Returns the parsed card object, or null when the PNG carries no card.
 */
export function extractCardFromPng(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (!isPng(bytes)) return null;

  const view = new DataView(arrayBuffer);
  const latin1 = new TextDecoder('latin1');
  const found = {};

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));

    if (type === 'IEND') break;

    if (type === 'tEXt') {
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const key = latin1.decode(chunk.subarray(0, nul));
        const value = latin1.decode(chunk.subarray(nul + 1));
        if (key === 'chara' || key === 'ccv3') found[key] = value;
      }
    }

    offset += 12 + length;          // length + type + data + CRC
    if (length < 0 || offset <= 0) break;
  }

  // V3 wins when both are present: it is the superset (it carries the
  // lorebook and group greetings that V2 has nowhere to put).
  const raw = found.ccv3 || found.chara;
  if (!raw) return null;

  try {
    return JSON.parse(base64ToUtf8(raw));
  } catch {
    try { return JSON.parse(raw); } catch { return null; }
  }
}

/* ---------- image re-encoding ---------- */

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image could not be decoded')); };
    img.src = url;
  });
}

/**
 * Re-encode an image Blob to a WebP data URL, downscaled to `maxSide`.
 * Falls back to a plain data URL when WebP encoding is unavailable.
 */
export async function blobToWebpDataUrl(blob, maxSide = AVATAR_MAX_SIDE, quality = WEBP_QUALITY) {
  let source;
  try {
    source = await createImageBitmap(blob);
  } catch {
    source = await loadImage(blob);
  }

  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  if (typeof source.close === 'function') source.close();

  const dataUrl = canvas.toDataURL('image/webp', quality);
  // Browsers that cannot encode WebP silently hand back a PNG data URL.
  return dataUrl.startsWith('data:image/webp') ? dataUrl : canvas.toDataURL('image/png');
}

export async function blobToGalleryDataUrl(blob) {
  return blobToWebpDataUrl(blob, GALLERY_MAX_SIDE, WEBP_QUALITY);
}
