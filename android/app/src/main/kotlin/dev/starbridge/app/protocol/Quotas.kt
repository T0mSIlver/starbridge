package dev.starbridge.app.protocol

import java.time.Instant

// How the Quotas tab reads a window (#1904): packages/protocol/src/quotas.ts, checked against
// quotas.json. The app formats the times the words are about.

/** Where a window is headed by its reset: [UNUSED] only when the uploader raised an unused-headroom alert. */
enum class QuotaCourse { UNKNOWN, RUNS_OUT, UNUSED, EVEN }

fun quotaCourse(pace: Pace?, unusedAlert: Boolean): QuotaCourse = when {
    pace == null || pace.stage == "unknown" -> QuotaCourse.UNKNOWN
    !pace.willLastToReset -> if (pace.runsOutAt == null) QuotaCourse.UNKNOWN else QuotaCourse.RUNS_OUT
    unusedAlert -> QuotaCourse.UNUSED
    else -> QuotaCourse.EVEN
}

/** What the state word says, and [word] its words; "Ran out" and "Will run out" go on with when. */
enum class QuotaState(val word: String) {
    RESET("Window reset"),
    UNKNOWN("Too early to tell"),
    RAN_OUT("Ran out"),
    OUT("Will run out"),
    UNUSED("Headroom unused"),
    OK("On pace"),
}

/** The reset passed: the window's use and pace belong to the cycle that ended. */
private fun ended(resetsAt: Instant?, now: Instant) = resetsAt?.isAfter(now) == false

fun quotaState(course: QuotaCourse, runsOutAt: Instant?, resetsAt: Instant?, now: Instant): QuotaState = when {
    ended(resetsAt, now) -> QuotaState.RESET
    else -> when (course) {
        QuotaCourse.UNKNOWN -> QuotaState.UNKNOWN
        QuotaCourse.RUNS_OUT -> if (runsOutAt != null && !runsOutAt.isAfter(now)) QuotaState.RAN_OUT else QuotaState.OUT
        QuotaCourse.UNUSED -> QuotaState.UNUSED
        QuotaCourse.EVEN -> QuotaState.OK
    }
}

/** Will run out or ran out, and has not reset: what "Running out first" moves up. */
fun quotaRunningOut(course: QuotaCourse, resetsAt: Instant?, now: Instant) =
    course == QuotaCourse.RUNS_OUT && !ended(resetsAt, now)

/** Every provider the windows name, in [order]; the ones not listed follow in the uploader's order. */
fun quotaProviders(providers: List<String>, order: List<String>): List<String> {
    val seen = providers.distinct()
    val known = order.filter { it in seen }
    return known + seen.filter { it !in known }
}

/**
 * The windows to show (spec/items.md, "Quota order"): [hidden] providers out, the rest by
 * provider in [order], a provider's machines by name, each machine's windows in the uploader's
 * order. With [runningOutFirst], windows that will run out or ran out, and have not reset, lead in
 * that same order.
 */
fun <T> arrangeQuotas(
    windows: List<T>,
    order: List<String>,
    hidden: List<String>,
    runningOutFirst: Boolean,
    provider: (T) -> String,
    machine: (T) -> String?,
    runningOut: (T) -> Boolean,
    names: Comparator<String>,
): List<T> {
    val rank = quotaProviders(windows.map(provider), order).withIndex().associate { (i, p) -> p to i }
    return windows.withIndex()
        .filter { provider(it.value) !in hidden }
        .sortedWith(
            compareBy<IndexedValue<T>> { if (runningOutFirst && runningOut(it.value)) 0 else 1 }
                .thenBy { rank.getValue(provider(it.value)) }
                .thenComparator { a, b -> names.compare(machine(a.value).orEmpty(), machine(b.value).orEmpty()) }
                .thenBy { it.index },
        )
        .map { it.value }
}
