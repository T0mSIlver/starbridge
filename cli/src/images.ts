import { readFileSync } from "node:fs";
import { type DecisionImage, toB64 } from "@starbridge/protocol";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { UsageError } from "./context";

/** A decoded picture, and the file it came from, which is sent as is when it already fits. */
export interface Picture {
  path: string;
  alt?: string;
  width: number;
  height: number;
  rgba: Uint8Array;
  /** `upright`: the stored pixels need no turning, so the file can go as is. */
  file: { type: DecisionImage["type"]; bytes: Uint8Array; upright: boolean };
}

/**
 * A phone screenshot's long edge, so one keeps every pixel for zooming in; past this a larger
 * image only costs bytes.
 */
const MAX_EDGE = 3000;
/** Below this an image is no use; the decision is refused instead. */
const MIN_EDGE = 240;
const QUALITIES = [80, 60] as const;

function typeOf(bytes: Uint8Array): DecisionImage["type"] | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
}

/**
 * A JPEG's EXIF orientation (1 to 8), which says how to turn the stored pixels upright; phone
 * cameras store portraits sideways and set 6 or 8. 1 when absent.
 */
export function exifOrientation(b: Uint8Array): number {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1] as number;
    const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    if (marker === 0xda) break;
    const start = i + 4;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(start, start + 4)) === "Exif") {
      const t = start + 6;
      const le = b[t] === 0x49;
      const u16 = (o: number) =>
        le
          ? (b[t + o] as number) | ((b[t + o + 1] as number) << 8)
          : ((b[t + o] as number) << 8) | (b[t + o + 1] as number);
      const u32 = (o: number) => (u16(le ? o + 2 : o) << 16) + u16(le ? o : o + 2);
      const ifd = u32(4);
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const at = ifd + 2 + e * 12;
        if (t + at + 10 > b.length) break;
        if (u16(at) === 0x0112) {
          const o = u16(at + 8);
          return o >= 1 && o <= 8 ? o : 1;
        }
      }
      return 1;
    }
    i = start - 2 + len;
  }
  return 1;
}

/** Turns RGBA pixels upright for an EXIF orientation: mirrors, then turns. */
function upright(
  rgba: Uint8Array,
  w: number,
  h: number,
  orientation: number,
): { rgba: Uint8Array; width: number; height: number } {
  if (orientation === 1) return { rgba, width: w, height: h };
  const swap = orientation >= 5;
  const width = swap ? h : w;
  const height = swap ? w : h;
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Where the upright pixel (x, y) is stored in the source.
      const [sx, sy] = (
        {
          2: [w - 1 - x, y],
          3: [w - 1 - x, h - 1 - y],
          4: [x, h - 1 - y],
          5: [y, x],
          6: [y, h - 1 - x],
          7: [w - 1 - y, h - 1 - x],
          8: [w - 1 - y, x],
        } as Record<number, [number, number]>
      )[orientation] as [number, number];
      out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { rgba: out, width, height };
}

export function loadPicture(path: string, alt?: string): Picture {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new UsageError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const type = typeOf(bytes);
  if (!type) throw new UsageError(`--image takes PNG or JPEG files: ${path}`);
  try {
    const img =
      type === "image/png"
        ? PNG.sync.read(Buffer.from(bytes))
        : jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    const orientation = type === "image/jpeg" ? exifOrientation(bytes) : 1;
    const turned = upright(new Uint8Array(img.data), img.width, img.height, orientation);
    return {
      path,
      ...(alt ? { alt } : {}),
      ...turned,
      // A turned photo is always re-encoded: clients ignore EXIF and would show it sideways.
      file: { type, bytes, upright: orientation === 1 },
    };
  } catch (e) {
    throw new UsageError(`cannot decode ${path}: ${(e as Error).message}`);
  }
}

/** Averages each target pixel's source area, over white so transparent parts stay light. */
function resize(p: Picture, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const sx = p.width / width;
  const sy = p.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * p.width + xx) * 4;
          const a = (p.rgba[i + 3] as number) / 255;
          r += (p.rgba[i] as number) * a + 255 * (1 - a);
          g += (p.rgba[i + 1] as number) * a + 255 * (1 - a);
          b += (p.rgba[i + 2] as number) * a + 255 * (1 - a);
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return out;
}

const image = (p: Picture, type: DecisionImage["type"], w: number, h: number, bytes: Uint8Array) =>
  ({
    type,
    width: w,
    height: h,
    data: toB64(bytes),
    ...(p.alt ? { alt: p.alt } : {}),
  }) satisfies DecisionImage;

/**
 * The picture in at most `maxBytes`: the file itself when it fits and is no larger than a screen
 * shows, else a JPEG scaled down until it fits. Throws when even a small one does not.
 */
export function fitPicture(p: Picture, maxBytes: number): DecisionImage {
  const longest = Math.max(p.width, p.height);
  if (p.file.upright && p.file.bytes.length <= maxBytes && longest <= MAX_EDGE)
    return image(p, p.file.type, p.width, p.height, p.file.bytes);
  // Start near the size a JPEG of this budget holds (screenshots take about 8 pixels a byte,
  // photos fewer), then step down.
  const guess = Math.sqrt((maxBytes * 8 * longest * longest) / (p.width * p.height));
  const smallest = Math.min(MIN_EDGE, longest);
  for (let edge = Math.min(longest, MAX_EDGE, Math.round(guess)); ; edge = Math.round(edge * 0.8)) {
    edge = Math.max(edge, smallest);
    const k = edge / longest;
    const w = Math.max(1, Math.round(p.width * k));
    const h = Math.max(1, Math.round(p.height * k));
    const data = resize(p, w, h);
    for (const quality of QUALITIES) {
      const bytes = jpeg.encode({ data, width: w, height: h }, quality).data;
      if (bytes.length <= maxBytes) return image(p, "image/jpeg", w, h, bytes);
    }
    if (edge === smallest)
      throw new UsageError(
        `${p.path} does not fit in ${maxBytes} bytes even at ${w}x${h}: attach fewer images`,
      );
  }
}
