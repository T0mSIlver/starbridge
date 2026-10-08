import { contextBridge, ipcRenderer } from "electron";

/** The server window's bridge: the address it shows, and Save. Only the app's own file gets it. */
if (location.protocol === "file:") {
  const prefix = "--starbridge-server=";
  contextBridge.exposeInMainWorld("starbridgeServer", {
    current: process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length),
    save: (url: string) => ipcRenderer.send("server", url),
    onError: (f: (message: string) => void) =>
      ipcRenderer.on("server-error", (_e, message: string) => f(message)),
  });
}
