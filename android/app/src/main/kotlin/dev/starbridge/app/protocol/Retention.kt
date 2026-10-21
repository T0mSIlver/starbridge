package dev.starbridge.app.protocol

/** The days each retention period lasts (packages/protocol's `RETENTION_DAYS`; vectors/retention.json keeps it in step). */
object Retention {
    const val DAY = 1L
    const val WEEK = 7L
    const val MONTH = 30L
}
