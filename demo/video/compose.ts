/**
 * The generated parts of the demo video.
 *
 *   bun demo/video/compose.ts image <dir>   the question's image, <dir>/question.png
 *   bun demo/video/compose.ts video <take>  <take>/demo.mp4, demo.gif and poster.png from a
 *                                           take's phone.mp4 and events.json
 *
 * Env: PHONE_OFFSET (seconds the phone recording lags the take's clock, default 0.3).
 */
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const FPS = 30;
const END_CARD = 3;
/** The status bar's share of the recording's height, cropped off (120 px of 2400). */
const STATUS_BAR = 0.05;
const PHONE = { x: 1385, y: 60, w: 455, h: 960 };

/** What frame.html exposes. */
interface Frame {
  layout(phone: typeof PHONE): void;
  render(t: number, take: unknown): void;
}

async function ffmpeg(...args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], { stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

const mb = (path: string) => `${(statSync(path).size / 1e6).toFixed(1)} MB`;

async function image(dir: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
  await page.goto(`file://${join(import.meta.dir, "question.html")}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, "question.png") });
  await browser.close();
}

async function video(take: string) {
  const data = JSON.parse(readFileSync(join(take, "events.json"), "utf8"));
  const duration = data.events.end + END_CARD;
  const frames = join(take, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`file://${join(import.meta.dir, "frame.html")}`);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((phone) => (window as unknown as Frame).layout(phone), PHONE);
  const count = Math.round(duration * FPS);
  for (let i = 0; i < count; i++) {
    await page.evaluate(([t, d]) => (window as unknown as Frame).render(t, d), [
      i / FPS,
      data,
    ] as const);
    const path = join(frames, `${String(i).padStart(5, "0")}.png`);
    await page.screenshot({ path, omitBackground: true });
  }
  await browser.close();

  // Trimmed after fps, which fills the still screen between the recording's sparse frames.
  const offset = Number(process.env.PHONE_OFFSET ?? 0.3);
  const mp4 = join(take, "demo.mp4");
  const phone =
    `[1]fps=${FPS},trim=start=${offset},setpts=PTS-STARTPTS,` +
    `crop=iw:ih*${1 - STATUS_BAR}:0:ih*${STATUS_BAR},` +
    `scale=${PHONE.w}:${PHONE.h}:flags=lanczos:force_original_aspect_ratio=increase,crop=${PHONE.w}:${PHONE.h}[p]`;
  const layers = `[0][p]overlay=${PHONE.x}:${PHONE.y}:eof_action=repeat[b];[b][2]overlay,format=yuv420p[v]`;
  await ffmpeg(
    ...["-f", "lavfi", "-i", `color=c=0x0c0c0c:s=1920x1080:r=${FPS}:d=${duration}`],
    ...["-i", join(take, "phone.mp4")],
    ...["-framerate", String(FPS), "-i", join(frames, "%05d.png")],
    ...["-filter_complex", `${phone};${layers}`, "-map", "[v]", "-t", String(duration), "-an"],
    ..."-c:v libx264 -preset slow -crf 24 -movflags +faststart".split(" "),
    mp4,
  );
  const gif = join(take, "demo.gif");
  const palette =
    "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];" +
    "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
  await ffmpeg("-i", mp4, "-filter_complex", palette, gif);
  const poster = String(data.events.notified + 1.5);
  await ffmpeg("-ss", poster, "-i", mp4, "-frames:v", "1", join(take, "poster.png"));
  console.log(`${mp4} (${mb(mp4)}, ${duration.toFixed(1)} s)\n${gif} (${mb(gif)})`);
}

const [command, dir] = process.argv.slice(2);
if (command === "image" && dir) await image(resolve(dir));
else if (command === "video" && dir) await video(resolve(dir));
else throw new Error("usage: compose.ts image <dir> | video <take>");
