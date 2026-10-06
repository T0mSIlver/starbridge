// The Colours setting before the first paint: layout.tsx inlines this script, so a forced
// theme never flashes the other one. Kept apart from prefs.ts, which the server layout cannot
// import.
export const PREFS_KEY = "starbridge:prefs";

export const THEME_SCRIPT = `try{var t=JSON.parse(localStorage.getItem("${PREFS_KEY}")||"{}").theme;if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

// Zod's schemas probe `new Function` once to choose a compiled parser, and the page's CSP reports
// the blocked probe as a violation. This script turns the probe off; it runs before the app's
// modules, which load with the page's flight data, and edits the config object Zod keeps.
export const ZOD_SCRIPT = "(globalThis.__zod_globalConfig??={}).jitless=true";
