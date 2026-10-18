package dev.starbridge.app.data

import dev.starbridge.app.protocol.Directory
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.SealedItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.OffsetDateTime
import dev.starbridge.app.protocol.Member as DirectoryMember

/**
 * One kind of item the store keeps: decisions, prompts, quotas, runs or join requests. The store
 * owns the session, the keys, the chain and the lock; it drives each kind through these calls, in
 * the order of its list, and the kind keeps its own part of [Saved] and its own screens' state.
 */
internal interface ItemKind {
    /** The push kinds [onPush] takes (PROTOCOL.md, "Push"). */
    val pushes: Set<String>

    /** Reads what is new from the server and keeps it: part of every full sync, under the lock. */
    suspend fun sync() {}

    /** Shows what [Saved] holds now, after every change to it. */
    fun publish(view: View) {}

    /** One push of a kind in [pushes], under the lock, its id and kind already checked. */
    suspend fun onPush(kind: String, id: String, push: JsonObject) {}

    /** [dir] revokes machines: their items' notifications close, since no answer reaches them. */
    fun revoked(dir: Directory) {}

    /** Signed out or removed from the devices: forgets what [Saved] does not hold. */
    fun wipe() {}
}

/** What a kind shows from: a hold empties every list (#362), and a revoked machine's items leave (#344). */
internal class View(val held: Boolean, val directory: Directory?) {
    fun active(from: String) = directory?.members?.get(from)?.active != false
}

/** An item that opened: its signer, its body, and the body's signed text, which is what is kept. */
internal data class Item(val from: String, val body: Any, val text: String)

/**
 * What an item kind needs from [ServerStore]. Calls that read or change [saved] run under [lock],
 * as every store run and push does.
 */
internal interface Core {
    val saved: Saved

    /** Keeps [newSaved] on disk and publishes it to every kind. */
    fun persist(newSaved: Saved)
    fun api(): Api
    val phase: StateFlow<Phase>
    val notice: MutableStateFlow<String?>
    val alerts: Alerts
    val envelopes: Envelopes
    val scope: CoroutineScope
    val lock: Mutex

    /** Null once a directory read found this phone removed. */
    val directory: Directory?
    val me: DirectoryMember
    val signKey: ByteArray
    fun now(): String
    fun newId(prefix: String): String

    /** A failure in the owner's words. */
    fun describe(e: Exception): String

    /** Turns a failure into a notice, as a store run does. */
    fun report(e: Exception, sync: Boolean = false)

    /** Why no machine's item counts now, or null (#362). */
    fun withheld(): String?

    /** Opens a machine's item against the chain and keeps the head it signed; null when it does not check out. */
    fun open(item: SealedItem): Item?

    /** Keeps the heads of [items] before any counts; true while a hold remains, which says why. */
    suspend fun scan(items: List<SealedItem>): Boolean

    /** Before a pushed item opens: reads the chain when its sender or head is new to this phone. */
    suspend fun catchUp(item: SealedItem)
    suspend fun syncDirectory()

    /**
     * The item a push of [kind] carries sealed to this phone, else fetched by [id] with the time it
     * was answered. [re] and [wakeAt] take those fields from the push.
     */
    suspend fun pushed(kind: String, id: String, push: JsonObject, re: Boolean = true, wakeAt: Boolean = false): Pair<SealedItem, String?>

    /** Appends [joining]'s add entry unless the chain holds it; [taken] says why one with its id differs. */
    suspend fun addMember(joining: DirectoryMember, taken: String)

    /** Runs [block] off the caller under the lock, and turns failures into a notice. */
    fun run(showBusy: Boolean = true, sync: Boolean = false, block: suspend () -> Unit)

    /** Runs [block] under the lock; a failure becomes a notice. */
    suspend fun locked(showBusy: Boolean = true, block: suspend () -> Unit)
}

internal fun instant(text: String?): Instant? = text?.let { runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() }
