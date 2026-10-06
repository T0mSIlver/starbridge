package dev.starbridge.app.data

import kotlinx.coroutines.flow.StateFlow

/** What the screens read and do. [ServerStore] implements it against the server. */
interface Store {
    val phase: StateFlow<Phase>
    val decisions: StateFlow<List<Decision>>
    /** Permission prompts of the last week, waiting ones included (#57). */
    val prompts: StateFlow<List<Prompt>>
    val windows: StateFlow<List<QuotaWindow>>
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
    /** The last thing that went wrong, in words for the owner. */
    val notice: StateFlow<String?>
    /** Answers going out or waiting for a connection, by decision id: the choice or the text, until the server takes them. */
    val sending: StateFlow<Map<String, String>>

    /** The URL that starts GitHub sign-in; it ends at starbridge://auth?code=… */
    fun gitHubSignInUrl(server: String): String
    /** The starbridge://auth redirect that ends GitHub sign-in. */
    fun receiveSignIn(redirect: String)
    fun signInWithOwnerToken(server: String, token: String)

    fun setUpFirstDevice()
    fun confirmRecoveryKey()
    fun joinAccount()
    /** Joins with a code another device shows as a QR code: the scanned link, or the code typed. */
    fun joinWithCode(text: String)
    /** Asks the account's devices to approve this phone by comparing digits. */
    fun askDevices()
    fun cancelJoin()
    fun recover(words: String)

    fun refresh()
    /** Asks the machines for fresh quota snapshots, waits for them, then refreshes. */
    fun refreshQuotas()
    fun answer(id: String, choice: String?, text: String?)
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

    /** Keeps [joinAsks] current while the app is in front. */
    fun watchJoins(on: Boolean)
    fun compareJoin(id: String)
    fun approveJoin()
    fun refuseJoin(id: String)
    fun closeComparison()
    fun revoke(memberId: String)

    fun setPushType(type: String)
    fun signOut()
    fun dismissNotice()
}
