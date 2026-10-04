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
  file: { type: DecisionImage["type"]; bytes: Uint8Array };
}

/** No phone or browser pane shows more than this, so a larger image only costs bytes. */
const MAX_EDGE = 1600;
/** Below this an image is no use; the decision is refused instead. */
const MIN_EDGE = 240;
const QUALITIES = [80, 60] as const;

function typeOf(bytes: Uint8Array): DecisionImage["type"] | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return undefined;
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
    return {
      path,
      ...(alt ? { alt } : {}),
      width: img.width,
      height: img.height,
      rgba: new Uint8Array(img.data),
      file: { type, bytes },
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
  if (p.file.bytes.length <= maxBytes && longest <= MAX_EDGE)
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
