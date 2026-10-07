/**
 * The generated parts of the demo video.
 *
 *   bun demo/video/compose.ts image <dir>   the question's image, <dir>/question.png
 *   bun demo/video/compose.ts video <take>  <take>/demo.mp4, demo.gif and poster.png from a
 *                                           take's events.json and its recording (phone.mp4
 *                                           or browser.webm)
 *
 * Env: OFFSET (seconds the recording lags the take's clock; default 0.3 for a phone, 0 else).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const FPS = 30;
const END_CARD = 3;
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where things sit in a 1920×1080 frame. `phone`: one terminal beside the phone, its status bar
 * cropped off (a share of the recording's height: 120 px of 2400). `inbox`: two terminals beside
 * a browser on the web inbox, recorded at the hole's size.
 */
const LAYOUTS = {
  phone: {
    recording: "phone.mp4",
    offset: 0.3,
    statusBar: 0.05,
    hole: { x: 1385, y: 60, w: 455, h: 960, r: 48 },
    terminals: [{ x: 80, y: 60, w: 1240, h: 880, size: 27 }],
    caption: { x: 80, w: 1240, y: 972 },
  },
  inbox: {
    recording: "browser.webm",
    offset: 0,
    statusBar: 0,
    hole: { x: 990, y: 50, w: 870, h: 900, r: 14 },
    terminals: [
      { x: 60, y: 50, w: 900, h: 438, size: 21 },
      { x: 60, y: 512, w: 900, h: 438, size: 21 },
    ],
    caption: { x: 0, w: 1920, y: 985 },
  },
};
export type Layout = keyof typeof LAYOUTS;
export const HOLE: Record<Layout, Rect> = { phone: LAYOUTS.phone.hole, inbox: LAYOUTS.inbox.hole };

/** What frame.html exposes. */
interface Frame {
  layout(l: (typeof LAYOUTS)[Layout]): void;
  render(t: number, take: unknown): void;
}

async function ffmpeg(...args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], { stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

const mb = (path: string) => `${(statSync(path).size / 1e6).toFixed(1)} MB`;

export async function image(dir: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
  await page.goto(`file://${join(import.meta.dir, "question.html")}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, "question.png") });
  await browser.close();
}

/** A stretch of the take played faster, such as a long run. */
interface Fast {
  from: number;
  to: number;
  rate: number;
}

/** The take's time at each output frame: its own pace, faster through `fast`, then the end card. */
export function timeline(end: number, fast: Fast[] = []): number[] {
  const times: number[] = [];
  for (let t = 0; t < end + END_CARD; ) {
    times.push(t);
    t += (fast.find((f) => t >= f.from && t < f.to)?.rate ?? 1) / FPS;
  }
  return times;
}

async function video(take: string) {
  const data = JSON.parse(readFileSync(join(take, "events.json"), "utf8"));
  const l = LAYOUTS[data.layout as Layout];
  const times = timeline(data.end, data.fast);
  const duration = times.length / FPS;
  const frames = join(take, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`file://${join(import.meta.dir, "frame.html")}`);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((l) => (window as unknown as Frame).layout(l), l);
  for (const [i, t] of times.entries()) {
    await page.evaluate(([t, d]) => (window as unknown as Frame).render(t, d), [t, data] as const);
    const path = join(frames, `${String(i).padStart(5, "0")}.png`);
    await page.screenshot({ path, omitBackground: true });
  }
  await browser.close();

  // The recording as frames on the take's clock: trimmed after fps, which fills the still screen
  // between a phone recording's sparse frames; then picked again at each output frame's time.
  const offset = Number(process.env.OFFSET ?? data.offset ?? l.offset);
  const { hole, statusBar } = l;
  const shot = join(take, "recording");
  rmSync(shot, { recursive: true, force: true });
  mkdirSync(join(shot, "picked"), { recursive: true });
  await ffmpeg(
    ...["-i", join(take, l.recording), "-vf"],
    `fps=${FPS},trim=start=${offset},setpts=PTS-STARTPTS,crop=iw:ih*${1 - statusBar}:0:ih*${statusBar},` +
      `scale=${hole.w}:${hole.h}:flags=lanczos:force_original_aspect_ratio=increase,crop=${hole.w}:${hole.h}`,
    ...["-q:v", "2", "-start_number", "0", join(shot, "%05d.jpg")],
  );
  const recorded = readdirSync(shot).filter((f) => f.endsWith(".jpg")).length;
  for (const [i, t] of times.entries()) {
    const from = Math.min(Math.round(t * FPS), recorded - 1);
    symlinkSync(
      join(shot, `${String(from).padStart(5, "0")}.jpg`),
      join(shot, "picked", `${String(i).padStart(5, "0")}.jpg`),
    );
  }

  const mp4 = join(take, "demo.mp4");
  await ffmpeg(
    ...["-f", "lavfi", "-i", `color=c=0x0c0c0c:s=1920x1080:r=${FPS}:d=${duration}`],
    ...["-framerate", String(FPS), "-i", join(shot, "picked", "%05d.jpg")],
    ...["-framerate", String(FPS), "-i", join(frames, "%05d.png")],
    "-filter_complex",
    `[0][1]overlay=${hole.x}:${hole.y}:eof_action=repeat[b];[b][2]overlay,format=yuv420p[v]`,
    ...["-map", "[v]", "-t", String(duration), "-an"],
    ..."-c:v libx264 -preset slow -crf 24 -movflags +faststart".split(" "),
    mp4,
  );
  rmSync(shot, { recursive: true, force: true });
  const gif = join(take, "demo.gif");
  const palette =
    "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];" +
    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
  await ffmpeg("-i", mp4, "-filter_complex", palette, gif);
  const poster = String(data.poster);
  await ffmpeg("-ss", poster, "-i", mp4, "-frames:v", "1", join(take, "poster.png"));
  console.log(`${mp4} (${mb(mp4)}, ${duration.toFixed(1)} s)\n${gif} (${mb(gif)})`);
}

if (import.meta.main) {
  const [command, dir] = process.argv.slice(2);
  if (command === "image" && dir) await image(resolve(dir));
  else if (command === "video" && dir) await video(resolve(dir));
  else throw new Error("usage: compose.ts image <dir> | video <take>");
}
