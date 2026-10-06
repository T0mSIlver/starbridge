/**
 * opencode sessions. opencode gives commands no session id, so the Starbridge opencode plugin
 * (`mod/opencode/starbridge.ts`) sets these for every command through its `shell.env` hook.
 */

/** The session's id. */
export const OPENCODE_SESSION = "STARBRIDGE_OPENCODE_SESSION";
/** The session's title. */
export const OPENCODE_TITLE = "STARBRIDGE_OPENCODE_TITLE";
/**
 * The session's id again, while the plugin submits answers into it: not in `opencode run`, which
 * exits once the session is idle. A command compares it with its own session's id, since an
 * `opencode run` started from another session's shell inherits that session's value.
 */
export const OPENCODE_ANSWERS = "STARBRIDGE_OPENCODE_ANSWERS";
