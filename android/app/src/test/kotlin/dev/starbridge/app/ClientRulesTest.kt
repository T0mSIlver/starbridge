package dev.starbridge.app

import dev.starbridge.app.data.Beacon
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.ROW_INPUT_MAX
import dev.starbridge.app.data.RETRY_FOR_MS
import dev.starbridge.app.data.Source
import dev.starbridge.app.data.SwipeSnooze
import dev.starbridge.app.data.laterSnooze
import dev.starbridge.app.data.laterWaiting
import dev.starbridge.app.data.snoozeStamp
import dev.starbridge.app.protocol.ANSWER_TEXT_MAX
import dev.starbridge.app.protocol.BLOB_MAX
import dev.starbridge.app.ui.inbox.SNOOZE_MAX
import dev.starbridge.app.ui.inbox.SNOOZE_MIN
import dev.starbridge.app.ui.inbox.snoozeAllowed
import dev.starbridge.app.ui.inbox.snoozeMenu
import dev.starbridge.app.ui.inbox.until
import java.io.File
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test

// The app's rules against packages/protocol/vectors/rules.json, which the web's and iOS's tests
// read too (#1429).
class ClientRulesTest {
    private val rules = Json.parseToJsonElement(
        File(System.getProperty("starbridge.vectors") ?: error("starbridge.vectors not set"), "rules.json").readText(),
    ).jsonObject
    private val zone = ZoneId.of("Europe/Paris")

    private fun local(s: String): Instant = LocalDateTime.parse(s).atZone(zone).toInstant()
    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content
    private fun JsonObject.long(k: String) = getValue(k).jsonPrimitive.long
    private fun JsonObject.list(k: String) = getValue(k).jsonArray.map { it.jsonPrimitive.content }

    @Test fun presenceRetryAndRowLimits() {
        val presence = rules.getValue("presence").jsonObject
        assertEquals(presence.long("inputMs"), Beacon.INPUT_MS)
        assertEquals(presence.long("beatMs"), Beacon.BEAT_MS)
        assertEquals(presence.long("checkMs"), Beacon.CHECK_MS)
        assertEquals(presence.getValue("holdChoices").jsonArray.map { it.jsonPrimitive.int }, Beacon.HOLD_CHOICES)
        assertEquals(rules.long("retryForMs"), RETRY_FOR_MS)
        assertEquals(rules.long("rowInputMax"), ROW_INPUT_MAX.toLong())
    }

    @Test fun limits() {
        val limits = rules.getValue("limits").jsonObject
        assertEquals(limits.long("answerTextMax"), ANSWER_TEXT_MAX.toLong())
        assertEquals(limits.long("blobMax"), BLOB_MAX.toLong())
    }

    @Test fun snooze() {
        val snooze = rules.getValue("snooze").jsonObject
        assertEquals(snooze.long("minMs"), SNOOZE_MIN.toMillis())
        assertEquals(snooze.long("maxMs"), SNOOZE_MAX.toMillis())
        for (c in snooze.getValue("presets").jsonArray.map { it.jsonObject }) {
            val want = c.getValue("presets").jsonArray.map { p -> p.jsonArray.let { it[0].jsonPrimitive.content to local(it[1].jsonPrimitive.content) } }
            assertEquals(c.str("now"), want, snoozeMenu(local(c.str("now")), zone))
        }
        for (c in snooze.getValue("allowed").jsonArray.map { it.jsonObject }) {
            assertEquals("${c.str("now")} → ${c.str("until")}", c.getValue("allowed").jsonPrimitive.boolean, snoozeAllowed(local(c.str("until")), local(c.str("now"))))
        }
        for (c in snooze.getValue("morning").jsonArray.map { it.jsonObject }) {
            assertEquals(c.str("now"), local(c.str("morning")), SwipeSnooze.Morning.until(local(c.str("now")), zone))
        }
    }

    @Test fun order() {
        val order = rules.getValue("order").jsonObject
        for (c in order.getValue("snooze").jsonArray.map { it.jsonObject }) {
            val kept = c["kept"]?.jsonObject
            val next = c.getValue("next").jsonObject
            assertEquals(c.str("name"), c.getValue("later").jsonPrimitive.boolean, laterSnooze(kept?.str("at"), kept?.str("until"), next.str("at"), next.str("until")))
        }
        for (c in order.getValue("waiting").jsonArray.map { it.jsonObject }) {
            val kept = c["kept"]?.jsonObject
            val next = c.getValue("next").jsonObject
            assertEquals(c.str("name"), c.getValue("later").jsonPrimitive.boolean, laterWaiting(kept?.str("at"), kept?.str("state"), next.str("at"), next.str("state")))
        }
        // The app stamps whole seconds.
        for (c in order.getValue("stamp").jsonArray.map { it.jsonObject }) {
            assertEquals(c.str("name"), c.str("seconds"), snoozeStamp(Instant.parse(c.str("now")), c["last"]?.jsonPrimitive?.content))
        }
    }

    @Test fun optionsRecommendedFirst() {
        for (c in rules.getValue("options").jsonArray.map { it.jsonObject }) {
            val d = Decision("d", "q", "", c.list("options"), c["recommended"]?.jsonPrimitive?.content, Source("m", "p", "s"), Instant.EPOCH)
            assertEquals(c.str("name"), c.list("ordered"), d.ordered)
        }
    }
}
