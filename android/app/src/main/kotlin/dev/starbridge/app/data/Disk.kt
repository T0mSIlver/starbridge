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
import dev.starbridge.app.protocol.parseBody
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import android.util.Log
import java.io.File

/**
 * A body as the machine signed it (#476). The text is the record: what this app reads from it is
 * parsed again on each start, so a field it learns later is there in what it kept before.
 */
private fun <T> parsed(kind: String, text: String): Lazy<T> = lazy {
    @Suppress("UNCHECKED_CAST")
    parseBody(kind, text) as T
}

/** A decision this device opened and verified, and what became of it. */
@Serializable
data class SavedDecision(
    /** The machine that signed it, and that an answer goes to. */
    val from: String,
    /** The signed body text. */
    val text: String,
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
    /** The owner's latest snooze of it, from any device (#571): until when, and when it was sent. */
    val snoozedUntil: String? = null,
    val snoozedAt: String? = null,
    /** Its images opened from their blobs, base64url, in order; null for one that did not open (#685). */
    val images: List<String?> = emptyList(),
) {
    val body: Decision by parsed("decision", text)
}

/**
 * A permission prompt this device opened and verified, and how it ended: [answer] is this
 * device's ("allow:once", "deny"), [settled] the asking machine's notice.
 */
@Serializable
data class SavedPrompt(
    val from: String,
    /** The signed body text. */
    val text: String,
    val answeredAt: String? = null,
    val answer: String? = null,
    /** The machine's settled notice, as it signed it. */
    val settledText: String? = null,
) {
    val body: Permission by parsed("permission", text)
    val settled: Settled? by lazy { settledText?.let { parseBody("settled", it) as Settled } }
}

/** The latest verified snapshot from one machine. */
@Serializable
data class SavedQuota(val from: String, val text: String) {
    val body: QuotaSnapshot by parsed("quota", text)
}

/** The latest verified update of one run. */
@Serializable
data class SavedRun(val from: String, val text: String) {
    val body: Run by parsed("run", text)
}

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
    /** The file's format ([FORMAT]); written even at its default, so a later one can tell. */
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault val v: Int = FORMAT,
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
    /** Runs dismissed on this phone (#827), by id, with the `at` of the update dismissed. */
    val dismissedRuns: Map<String, String> = emptyMap(),
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
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault val v: Int = FORMAT,
    val session: String? = null,
    val boxPk: String? = null,
    val boxSk: String? = null,
    val signPk: String? = null,
    val signSk: String? = null,
    /** The first device's recovery seed, kept until the owner says the key is written down. */
    val recoverySeed: String? = null,
    /** While joining: the claim secret that fetches the approval. */
    val claim: String? = null,
    /** While joining by digits: the ephemeral X25519 key pair. */
    val joinPk: String? = null,
    val joinSk: String? = null,
    /** While GitHub sign-in is open in the browser: the PKCE verifier behind its challenge. */
    val signInVerifier: String? = null,
)

/**
 * The format of `state.bin` and `secrets.bin`, written as `v` (#473); a later format raises it
 * and reads the ones before.
 */
const val FORMAT = 1

/**
 * [Saved] without the items whose kept text this app no longer reads, so a body never throws when
 * a screen reads it. Reading them again would not help: the server holds the same signed text.
 */
fun Saved.readable(): Saved {
    fun ok(read: () -> Any?) = runCatching { read() }.onFailure { Log.w("Starbridge", "dropped a saved item: ${it.message}") }.isSuccess
    return copy(
        decisions = decisions.filter { ok { it.body } },
        prompts = prompts.filter { ok { it.body; it.settled } },
        quotas = quotas.filter { ok { it.body } },
        runs = runs.filter { ok { it.body } },
    )
}

/** Both files are wrapped by the [Vault], so nothing decrypted sits on the disk in the clear. */
class Disk(private val dir: File, private val vault: Vault) {
    /** Files this app could not read at [load], a newer app's or a damaged one. */
    val unreadable = mutableListOf<String>()

    private fun <T> read(name: String, serializer: KSerializer<T>, format: (T) -> Int): Result<T?> {
        val file = File(dir, name)
        if (!file.isFile) return Result.success(null)
        return runCatching { ProtocolJson.decodeFromString(serializer, vault.unwrap(file.readBytes()).decodeToString()) }
            .mapCatching { if (format(it) == FORMAT) it else error("format ${format(it)}") }
    }

    /**
     * Both files, read together: they describe one device, so when either cannot be read, both
     * move aside to `<name>.unreadable-<time>`, kept rather than overwritten, and the app starts
     * signed out.
     */
    fun load(): Pair<Saved?, Secrets> {
        val saved = read("state.bin", Saved.serializer()) { it.v }
        val secrets = read("secrets.bin", Secrets.serializer()) { it.v }
        if (saved.isSuccess && secrets.isSuccess) return saved.getOrNull() to (secrets.getOrNull() ?: Secrets())
        if (saved.isFailure) unreadable += "state.bin"
        if (secrets.isFailure) unreadable += "secrets.bin"
        val at = System.currentTimeMillis()
        for (name in listOf("state.bin", "secrets.bin")) File(dir, name).takeIf { it.isFile }?.renameTo(File(dir, "$name.unreadable-$at"))
        return null to Secrets()
    }

    private fun <T> write(name: String, serializer: KSerializer<T>, value: T) {
        dir.mkdirs()
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(vault.wrap(ProtocolJson.encodeToString(serializer, value).encodeToByteArray()))
        check(tmp.renameTo(File(dir, name)))
    }

    /** The saved state as it is on disk now, or null; moves nothing ([load] does). */
    fun saved(): Saved? = read("state.bin", Saved.serializer()) { it.v }.getOrNull()
    fun save(saved: Saved) = write("state.bin", Saved.serializer(), saved)
    /** The secrets as they are on disk now, or none; moves nothing. */
    fun secrets(): Secrets = read("secrets.bin", Secrets.serializer()) { it.v }.getOrNull() ?: Secrets()
    fun save(secrets: Secrets) = write("secrets.bin", Secrets.serializer(), secrets)

    fun wipe() {
        File(dir, "state.bin").delete()
        File(dir, "secrets.bin").delete()
    }
}
