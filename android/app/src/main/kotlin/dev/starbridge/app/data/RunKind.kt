package dev.starbridge.app.data

import dev.starbridge.app.protocol.Retention
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.time.Instant

/** Runs: each machine's long tasks, the latest update of each, kept a day (#827). */
internal class RunKind(private val core: Core) : ItemKind {
    override val pushes = setOf("run")
    val shown = MutableStateFlow<List<Run>>(emptyList())

    private val saved get() = core.saved

    override fun publish(view: View) {
        shown.value = if (view.held) emptyList() else saved.runs.filter { view.active(it.from) }.map(::toUi)
    }

    /** Every run the server holds, the latest update of each. */
    override suspend fun sync() {
        var cursor = ""
        val fresh = mutableListOf<SavedRun>()
        while (true) {
            val page = core.api().items("run", cursor)
            if (core.scan(page.items.map { it.item })) return
            for (listed in page.items) core.open(listed.item)?.let { fresh += SavedRun(it.from, it.text) }
            cursor = page.cursor
            if (page.last) break
        }
        keep(fresh, fromSync = true)
    }

    override suspend fun onPush(kind: String, id: String, push: JsonObject) {
        val (item) = core.pushed("run", id, push, re = false)
        core.catchUp(item)
        val opened = core.open(item) ?: return
        keep(listOf(SavedRun(opened.from, opened.text)))
    }

    fun dismiss(id: String) {
        core.run(showBusy = false) {
            val r = saved.runs.find { it.body.id == id } ?: return@run
            core.persist(saved.copy(runs = saved.runs - r, dismissedRuns = saved.dismissedRuns + (id to r.body.at)))
            core.alerts.cancelRun(id)
            try {
                core.api().deleteItem(id)
            } catch (e: ApiException) {
                if (e.status == 401) throw e
                // 404: gone already, or a server without the route; this phone hides it either way.
                if (e.status != 404) core.notice.value = "Dismissed on this phone only: ${core.describe(e)}"
            } catch (e: IOException) {
                core.notice.value = "No connection. Dismissed on this phone only."
            }
        }
    }

    /**
     * Keeps each update newer than the one held for its run (by `at`, then the exit), drops runs
     * with no news for a day, as the server does, and hands each newer update to [Alerts]. A sync
     * skips runs it first learns of already ended, so a new phone does not alert for old results.
     * A sync lists every run the server holds, so a run it leaves out was dismissed on another
     * device (#827). A run dismissed here stays out until its machine posts a newer update.
     */
    private fun keep(updates: List<SavedRun>, fromSync: Boolean = false) {
        fun rank(r: SavedRun) = (instant(r.body.at) ?: Instant.EPOCH) to (r.body.exit != null)
        val dismissed = saved.dismissedRuns
        val listed = updates.map { it.body.id }.toSet()
        val (kept, gone) = saved.runs.partition { !fromSync || it.body.id in listed }
        gone.forEach { core.alerts.cancelRun(it.body.id) }
        val held = kept.associateBy { it.body.id }.toMutableMap()
        val newer = updates.filter { u -> dismissed[u.body.id]?.let { at -> (instant(u.body.at) ?: Instant.EPOCH) > (instant(at) ?: Instant.EPOCH) } ?: true }.filter { u ->
            val h = held[u.body.id]
            val (at, exited) = rank(u)
            val wins = h == null || rank(h).let { (hAt, hExited) -> at > hAt || (at == hAt && exited && !hExited) }
            if (wins) held[u.body.id] = u
            wins && !(fromSync && h == null && exited)
        }
        val dayAgo = Instant.now().minus(java.time.Duration.ofDays(Retention.DAY))
        core.persist(
            saved.copy(
                runs = held.values.filter { toUi(it).lastNews > dayAgo }.sortedBy { it.body.startedAt },
                dismissedRuns = dismissed.filter { (id, at) -> id !in held && (instant(at) ?: Instant.EPOCH) > dayAgo },
            ),
        )
        newer.forEach { core.alerts.run(toUi(it)) }
    }

    private fun toUi(r: SavedRun): Run {
        val b = r.body
        return Run(
            id = b.id,
            title = b.title,
            reason = b.reason,
            source = Source(b.source.machine, b.source.project, b.source.session, b.source.sessionTitle, b.source.links.orEmpty().map { SessionLink(it.kind, it.url) }, b.source.machineKind),
            startedAt = instant(b.startedAt) ?: Instant.EPOCH,
            at = instant(b.at) ?: Instant.EPOCH,
            progress = b.progress?.let { Run.Progress(it.done, it.total, it.unit == "percent") },
            exitCode = b.exit?.code,
            endedAt = instant(b.exit?.at),
        )
    }
}
