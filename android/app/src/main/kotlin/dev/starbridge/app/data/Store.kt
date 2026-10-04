package dev.starbridge.app.data

import kotlinx.coroutines.flow.StateFlow

/** What the screens read and do. [ServerStore] implements it against the server. */
interface Store {
    val phase: StateFlow<Phase>
    val decisions: StateFlow<List<Decision>>
    val windows: StateFlow<List<QuotaWindow>>
    val members: StateFlow<List<Member>>
    val approval: StateFlow<Approval>
    val push: StateFlow<PushSetting>
    val server: StateFlow<String>
    /** A setup step or a sync is running. */
    val busy: StateFlow<Boolean>
    /** The last thing that went wrong, in words for the owner. */
    val notice: StateFlow<String?>

    /** The URL that starts GitHub sign-in; it ends at starbridge://auth?code=… */
    fun gitHubSignInUrl(server: String): String
    /** The starbridge://auth redirect that ends GitHub sign-in. */
    fun receiveSignIn(redirect: String)
    fun signInWithOwnerToken(server: String, token: String)

    fun setUpFirstDevice()
    fun confirmRecoveryKey()
    fun joinAccount()
    fun cancelJoin()
    fun recover(words: String)

    fun refresh()
    fun answer(id: String, choice: String?, text: String?)

    fun lookUpPairing(code: String)
    fun approvePairing()
    fun closePairing()
    fun revoke(memberId: String)

    fun setPushType(type: String)
    fun signOut()
    fun dismissNotice()
}
