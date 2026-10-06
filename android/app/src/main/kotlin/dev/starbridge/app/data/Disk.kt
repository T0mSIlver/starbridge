package dev.starbridge.app.data

import dev.starbridge.app.protocol.Decision
import dev.starbridge.app.protocol.DirectoryHead
import dev.starbridge.app.protocol.Member
import dev.starbridge.app.protocol.Permission
import dev.starbridge.app.protocol.Pin
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.QuotaSnapshot
import dev.starbridge.app.protocol.SealedItem
import dev.starbridge.app.protocol.Settled
import dev.starbridge.app.protocol.Run
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.io.File

/** 1: images, links and answerIn (#62). 2: replies (#201). 3: theirAnswer and answeredBy (#330). */
const val DECISION_FIELDS = 3

/** A decision this device opened and verified, and what became of it. */
@Serializable
data class SavedDecision(
    /** The machine that signed it, and that an answer goes to. */
    val from: String,
    val body: Decision,
    val answeredAt: String? = null,
    /** Set when this device answered: the choice or the text. */
    val answer: String? = null,
    /** How the machine closed it, when its settled notice did rather than an answer. */
    val settled: String? = null,
    /** Another device's answer the machine took, and that device's id, from its notice (#330). */
    val theirAnswer: String? = null,
    val answeredBy: String? = null,
    /** The agent's latest waiting state for it, "working" or "waiting", and when it flipped. */
    val waiting: String? = null,
    val waitingAt: String? = null,
)

/**
 * A permission prompt this device opened and verified, and how it ended: [answer] is this
 * device's ("allow:once", "deny"), [settled] the asking machine's notice.
 */
@Serializable
data class SavedPrompt(
    val from: String,
    val body: Permission,
    val answeredAt: String? = null,
    val answer: String? = null,
    val settled: Settled? = null,
)

/** The latest verified snapshot from one machine. */
@Serializable
data class SavedQuota(val from: String, val body: QuotaSnapshot)

/** The latest verified update of one run. */
@Serializable
data class SavedRun(val from: String, val body: Run)

/**
 * An answer signed and sealed but not yet taken by the server: offline, say. [answer] is the
 * choice or the text; [mayHaveLanded] is set once an attempt failed after the request may have
 * reached the server, so a later `already-answered` is most likely this answer's own (#329).
 */
@Serializable
data class QueuedAnswer(val decisionId: String, val answer: String, val item: SealedItem, val mayHaveLanded: Boolean = false)

@Serializable
data class SavedPush(val type: String, val id: String, val endpoint: String)

/** Everything the app keeps between runs, besides [Secrets]. */
@Serializable
data class Saved(
    val server: String,
    val account: String? = null,
    /** Another device already set the account up, so this one joins or recovers. */
    val accountExists: Boolean = false,
    /** This device, once it is in the directory. */
    val me: Member? = null,
    val pin: Pin? = null,
    /** The longest directory head each machine signed into its items (#362). */
    val heads: Map<String, DirectoryHead> = emptyMap(),
    /** The verified directory chain, so later fetches only ask for what is new. */
    val entries: List<JsonElement> = emptyList(),
    val cursor: String = "",
    val decisions: List<SavedDecision> = emptyList(),
    /**
     * The decision fields this app kept when it saved [decisions]; below [DECISION_FIELDS], the
     * open ones are read again from the server, since an older app dropped fields it did not know.
     */
    val decisionFields: Int = 0,
    /** Where the last read of permission prompts and settled notices stopped. */
    val promptCursor: String = "",
    val prompts: List<SavedPrompt> = emptyList(),
    /** Answers waiting to be sent, oldest first. */
    val outbox: List<QueuedAnswer> = emptyList(),
    val quotas: List<SavedQuota> = emptyList(),
    val runs: List<SavedRun> = emptyList(),
    /** "fcm" or "unifiedpush". */
    val pushType: String = "fcm",
    val push: SavedPush? = null,
    /** While this device waits for another to approve it: the code it shows, or scanned. */
    val joining: String? = null,
    val joiningScanned: Boolean = false,
    /** While this device waits for a join by digits. */
    val digitJoin: SavedDigitJoin? = null,
    /** The first device's signed genesis entry, kept until the server's chain is known to hold it. */
    val pendingGenesis: JsonElement? = null,
    /** While recovering: the member whose keys this phone made, until the chain holds it. */
    val recovering: Member? = null,
    /** The last replacement of the recovery key whose notice this phone dismissed (its seq). */
    val recoverySeen: Int = -1,
)

/**
 * A join by digits in progress: the request text this phone posted, and the first approver key
 * it saw. The digits commit to that key, so this phone never answers a second one.
 */
@Serializable
data class SavedDigitJoin(val id: String, val request: String, val approverKey: String? = null, val digits: String? = null, val matched: Boolean = false)

/** Private keys and tokens. */
@Serializable
data class Secrets(
    val session: String? = null,
    val boxPk: String? = null,
    val boxSk: String? = null,
    val signPk: String? = null,
    val signSk: String? = null,
    /** The first device's recovery seed, kept until the owner says the words are written down. */
    val recoverySeed: String? = null,
    /** While joining: the claim secret that fetches the approval. */
    val claim: String? = null,
    /** While joining by digits: the ephemeral X25519 key pair. */
    val joinPk: String? = null,
    val joinSk: String? = null,
    /** While GitHub sign-in is open in the browser: the PKCE verifier behind its challenge. */
    val signInVerifier: String? = null,
)

/** Both files are wrapped by the [Vault], so nothing decrypted sits on the disk in the clear. */
class Disk(private val dir: File, private val vault: Vault) {
    private fun <T> read(name: String, serializer: KSerializer<T>): T? {
        val file = File(dir, name)
        if (!file.isFile) return null
        return runCatching { ProtocolJson.decodeFromString(serializer, vault.unwrap(file.readBytes()).decodeToString()) }.getOrNull()
    }

    private fun <T> write(name: String, serializer: KSerializer<T>, value: T) {
        dir.mkdirs()
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(vault.wrap(ProtocolJson.encodeToString(serializer, value).encodeToByteArray()))
        check(tmp.renameTo(File(dir, name)))
    }

    fun saved(): Saved? = read("state.bin", Saved.serializer())
    fun save(saved: Saved) = write("state.bin", Saved.serializer(), saved)
    fun secrets(): Secrets = read("secrets.bin", Secrets.serializer()) ?: Secrets()
    fun save(secrets: Secrets) = write("secrets.bin", Secrets.serializer(), secrets)

    fun wipe() {
        File(dir, "state.bin").delete()
        File(dir, "secrets.bin").delete()
    }
}
