package dev.starbridge.app.data

import dev.starbridge.app.protocol.QuotaCourse
import dev.starbridge.app.protocol.quotaCourse
import dev.starbridge.app.ui.span
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import kotlin.math.roundToInt

/** Quotas: each machine's latest snapshot of its AI plans' windows, and the alerts it raised. */
internal class QuotaKind(private val core: Core) : ItemKind {
    override val pushes = setOf("quota")
    val windows = MutableStateFlow<List<QuotaWindow>>(emptyList())
    val failures = MutableStateFlow<List<QuotaFailure>>(emptyList())
    val held = MutableStateFlow(false)

    /** The server listed quota snapshots on the last read, even ones this phone cannot open yet. */
    @Volatile private var listed = false

    private val saved get() = core.saved

    override fun publish(view: View) {
        // As the web: named once the account has more than one active machine.
        val named = (view.directory?.members?.values?.count { it.active && it.member.role == "machine" } ?: 0) > 1
        windows.value = if (view.held) emptyList() else saved.quotas.filter { view.active(it.from) }.flatMap { toUi(it, named) }
        failures.value = if (view.held) emptyList() else saved.quotas.filter { view.active(it.from) }.flatMap { failuresOf(it, named) }
        held.value = listed || saved.quotas.isNotEmpty()
    }

    override suspend fun sync() {
        val listed = core.api().quota()
        this.listed = listed.isNotEmpty()
        if (core.scan(listed.map { it.item })) return
        // A snapshot this app cannot open keeps that machine's last good one, rather than blanking it.
        val quotas = listed.mapNotNull { l ->
            core.open(l.item)?.let { SavedQuota(it.from, it.text) } ?: saved.quotas.find { it.from == l.item.from }
        }
        core.persist(saved.copy(quotas = quotas))
        core.alerts.quota(quotas.flatMap(::notices))
    }

    override suspend fun onPush(kind: String, id: String, push: JsonObject) = sync()

    /** The next account's Quotas tab waits for its own read, as on iOS and the web. */
    override fun wipe() {
        listed = false
    }

    private fun notices(q: SavedQuota): List<QuotaNotice> {
        val now = Instant.now()
        val labels = q.body.providers.flatMap { p -> p.windows.map { "${p.provider}/${it.id}" to it.label.ifBlank { it.id } } }.toMap()
        val minutes = q.body.providers.flatMap { p -> p.windows.map { "${p.provider}/${it.id}" to it.windowMinutes } }.toMap()
        return q.body.alerts.filter { it.notify == true }.map { a ->
            val name = "${a.provider} ${labels["${a.provider}/${a.window}"] ?: a.window}"
            val resets = instant(a.resetsAt)?.let { "in ${span(now, it)}" } ?: "soon"
            val (title, text) = when (a.kind) {
                "low" -> "$name: ${a.threshold}% left" to "Resets $resets."
                "runs-out" -> "$name will run out" to (instant(a.runsOutAt)?.let { "Runs out in ${span(now, it)} at this pace; resets $resets." } ?: "Resets $resets.")
                else -> "$name resets with headroom unused" to "Resets $resets with ${a.unusedPercent?.roundToInt() ?: 0}% unused."
            }
            QuotaNotice("${q.body.id}/${a.provider}/${a.window}/${a.kind}", a.provider, a.window, a.kind, title, text, a.threshold, minutes["${a.provider}/${a.window}"])
        }
    }

    private fun machineName(from: String, named: Boolean) = if (named) core.directory?.members?.get(from)?.member?.name ?: from else null

    private fun failuresOf(q: SavedQuota, named: Boolean): List<QuotaFailure> = q.body.providers.mapNotNull { p ->
        p.error?.takeIf { p.windows.isEmpty() }?.let { QuotaFailure(p.provider, it, machineName(q.from, named)) }
    }

    private fun toUi(q: SavedQuota, named: Boolean): List<QuotaWindow> = q.body.providers.flatMap { p ->
        p.windows.map { w ->
            // The card's state follows a pace alert; "low" only notifies.
            val alerts = q.body.alerts.filter { it.provider == p.provider && it.window == w.id && it.kind != "low" }
            val pace = w.pace
            val unused = alerts.firstOrNull { it.kind == "unused-headroom" }?.unusedPercent
            QuotaWindow(
                id = "${q.from}/${p.provider}/${w.id}",
                provider = p.provider,
                window = w.label.ifBlank { w.id },
                usedPercent = w.usedPercent.roundToInt(),
                resetsAt = instant(w.resetsAt),
                pace = paceOf(pace, unused),
                alert = alerts.isNotEmpty(),
                steadyPercent = pace?.expectedUsedPercent?.roundToInt()?.coerceIn(0, 100),
                windowMinutes = w.windowMinutes,
                machine = machineName(q.from, named),
                takenAt = instant(p.updatedAt ?: q.body.takenAt),
                error = p.error,
            )
        }
    }
}

/** A window's course by the protocol's rule (quotaCourse), with what the card shows of it. */
internal fun paceOf(pace: dev.starbridge.app.protocol.Pace?, unusedAlert: Double?): Pace = when (quotaCourse(pace, unusedAlert != null)) {
    QuotaCourse.UNKNOWN -> Pace.Unknown
    QuotaCourse.RUNS_OUT -> pace?.runsOutAt?.let(::instant)?.let { Pace.RunsOut(it) } ?: Pace.Unknown
    QuotaCourse.UNUSED -> Pace.Unused(unusedAlert!!.roundToInt())
    QuotaCourse.EVEN -> Pace.Even
}
