// The Colours setting before the first paint: layout.tsx inlines this script, so a forced
// theme never flashes the other one. Kept apart from prefs.ts, which the server layout cannot
// import.
export const PREFS_KEY = "starbridge:prefs";

export const THEME_SCRIPT = `try{var t=JSON.parse(localStorage.getItem("${PREFS_KEY}")||"{}").theme;if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
