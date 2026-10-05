// The chime for new questions and prompts while a page is open (#165). A service worker cannot
// play audio and browsers honour no sound option on Web Push, so the page plays it.
import { getPref } from "./prefs";

let ctx: AudioContext | undefined;

/** Browsers start audio only after a tap or key on the page: make the context on the first one. */
export function unlockSound(): void {
  if (typeof window === "undefined") return;
  const unlock = () => {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  for (const ev of ["pointerdown", "keydown"])
    window.addEventListener(ev, unlock, { once: true, capture: true });
}

/** Two soft notes, a fifth apart. */
export function chime(): void {
  ctx ??= new AudioContext();
  // Before the page's first tap the notes would wait and all play on that tap.
  if (ctx.state === "suspended") return;
  const t = ctx.currentTime;
  for (const [i, hz] of [880, 1318.5].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    const at = t + i * 0.12;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.5);
  }
}

/** Chimes once across this browser's open pages, when the setting is on. */
export function chimeForNew(): void {
  if (!getPref("sound")) return;
  const locks = navigator.locks;
  if (!locks) {
    chime();
    return;
  }
  locks
    .request("starbridge-chime", { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      chime();
      // Holds the lock past the other pages' copies of the same push.
      await new Promise((r) => setTimeout(r, 1500));
    })
    .catch(() => {});
}
