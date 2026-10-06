package dev.starbridge.app.data

import kotlinx.coroutines.flow.StateFlow

/** What the screens read and do. [ServerStore] implements it against the server. */
interface Store {
    val phase: StateFlow<Phase>
    val decisions: StateFlow<List<Decision>>
    /** Permission prompts of the last week, waiting ones included (#57). */
    val prompts: StateFlow<List<Prompt>>
    val windows: StateFlow<List<QuotaWindow>>
    /** Providers CodexBar failed for with no windows to keep (#450). */
    val quotaFailures: StateFlow<List<QuotaFailure>>
    /** Runs the server still holds: the latest update of each, for a day. */
    val runs: StateFlow<List<Run>>
    val members: StateFlow<List<Member>>
    val approval: StateFlow<Approval>
    /** Open join requests from browsers and phones signed in to the account. */
    val joinAsks: StateFlow<List<JoinAsk>>
    val comparison: StateFlow<Comparison>
    val push: StateFlow<PushSetting>
    val server: StateFlow<String>
    /** A setup step or a sync is running. */
    val busy: StateFlow<Boolean>
    /**
     * The release the server needs, once it refused this one (#497): the app shows only the
     * screen that updates it. An updated app starts without it.
     */
    val tooOld: StateFlow<String?>
    /** The last thing that went wrong, in words for the owner. */
    val notice: StateFlow<String?>
    /** Answers going out or waiting for a connection, by decision id: the choice or the text, until the server takes them. */
    val sending: StateFlow<Map<String, String>>
    /** The recovery key's state, once the directory is known (#348). */
    val recovery: StateFlow<RecoveryUi?>
    val replacing: StateFlow<Replacing>

    /** The URL that starts GitHub sign-in; it ends at a link [SignIn.redirect] reads. */
    fun gitHubSignInUrl(server: String): String
    /** The redirect that ends GitHub sign-in. */
    fun receiveSignIn(redirect: String)
    fun signInWithOwnerToken(server: String, token: String)

    fun setUpFirstDevice()
    fun confirmRecoveryKey()
    fun joinAccount()
    /** Joins with a code another device shows as a QR code: the scanned link, or the code typed. */
    fun joinWithCode(text: String)
    /** Asks the account's devices to approve this phone by comparing digits. */
    fun askDevices()
    /** The owner saw the same digits on the device comparing them: its approval may count. */
    fun confirmDigits()
    fun cancelJoin()
    fun recover(key: String)

    /** Syncs everything; [shown] false keeps [busy] down, for syncs the owner didn't ask for. */
    fun refresh(shown: Boolean = true)
    /** Asks the machines for fresh quota snapshots, waits for them, then refreshes. */
    fun refreshQuotas()
    /** Answers [id] with [choice] or [text]; with neither, Done: answered on its own page (#539). */
    fun answer(id: String, choice: String?, text: String?)
    /** Puts question [id] off until [until] (#571); a time already passed brings it back. */
    fun snooze(id: String, until: java.time.Instant)
    /** Allows prompt [id] for [scope] ("once", "session", "project"), or denies it with [message]. */
    fun answerPrompt(id: String, allow: Boolean, scope: String, message: String?)
    /** Reads prompts again, quickly, while one waits on screen. */
    fun refreshPrompts()
    /** Reads the directory again, quietly, while the device list is on screen. */
    fun refreshDirectory()

    fun lookUpPairing(code: String)
    fun approvePairing()
    fun closePairing()
    /** Shows a QR code for a new phone to scan, and waits for its request. */
    fun showCode()

    /** Polls the items while the app is in front and no push has arrived ([on] false stops it). */
    fun foreground(on: Boolean)

    /** Keeps [joinAsks] current while the app is in front. */
    fun watchJoins(on: Boolean)
    fun compareJoin(id: String)
    fun approveJoin()
    fun refuseJoin(id: String)
    fun closeComparison()
    fun revoke(memberId: String)

    /** Makes a new recovery key to show, once [currentKey] proves to be the chain's. */
    fun newRecoveryKey(currentKey: String)
    /** Proposes the new key and confirms it with the current one. */
    fun saveRecoveryKey()
    fun closeRecoveryKey()
    fun dismissRecoveryNotice(seq: Int)

    fun setPushType(type: String)
    fun signOut()
    fun dismissNotice()
}
