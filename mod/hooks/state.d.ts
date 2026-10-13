// The value register.ts keeps in `$.state`: the token of the process it runs in (sent.ts).
declare module "claude-code" {
  interface PluginState {
    "starbridge-mod": { process: string };
  }
}
