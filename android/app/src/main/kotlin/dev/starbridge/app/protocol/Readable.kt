package dev.starbridge.app.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A string that is not one of [known]: what a newer sender may send. */
private fun JsonElement?.newer(known: Set<String>) = this is JsonPrimitive && isString && content !in known

private fun JsonObject.with(key: String, value: JsonElement?) = JsonObject(if (value == null) this - key else this + (key to value))

private fun withSource(body: JsonObject): JsonObject {
    val source = body["source"] as? JsonObject ?: return body
    return if (source["machineKind"].newer(MACHINE_KINDS)) body.with("source", source.with("machineKind", null)) else body
}

/** The fields that are null by design (`.nullable()` in schemas.ts). */
private val NULLABLE = setOf("prev", "projectedUsedPercent", "runsOutAt", "windowMinutes", "resetsAt", "pace")

/**
 * Refuses a null anywhere else, as zod does (#505): this app's classes take a null for an absent
 * optional field, so without this an item with `"progress": null` would show here and nowhere else.
 */
private fun refuseNulls(json: JsonElement) {
    when (json) {
        is JsonObject -> json.forEach { (k, v) ->
            if (v is JsonNull && k !in NULLABLE) throw ProtocolException("bad-schema", "$k: null")
            refuseNulls(v)
        }
        is JsonArray -> json.forEach(::refuseNulls)
        else -> {}
    }
}

/**
 * What a reader makes of a body before it is decoded and checked, as `readable` in
 * packages/protocol (PROTOCOL.md, "What a reader keeps"): a string it only displays and does
 * not know reads as the neutral case, and an alert of a kind it does not know is left out. A
 * missing field, or a value of another type, is left for the schema to refuse.
 */
fun readable(kind: String, json: JsonElement): JsonElement {
    refuseNulls(json)
    val body = json as? JsonObject ?: return json
    return when (kind) {
        "decision", "permission" -> withSource(body)
        "settled" -> if (body["outcome"].newer(SETTLED_OUTCOMES)) body.with("outcome", null) else body
        "waiting" -> if (body["state"].newer(WAITING_STATES)) body.with("state", JsonPrimitive("working")) else body
        "run" -> withSource(body).let { b ->
            val unit = (b["progress"] as? JsonObject)?.get("unit")
            if (unit.newer(RUN_UNITS)) b.with("progress", null) else b
        }
        "quota" -> {
            var b = body
            (b["providers"] as? JsonArray)?.let { providers ->
                b = b.with("providers", JsonArray(providers.map { p ->
                    val windows = (p as? JsonObject)?.get("windows") as? JsonArray ?: return@map p
                    p.with("windows", JsonArray(windows.map { w ->
                        val pace = (w as? JsonObject)?.get("pace") as? JsonObject
                        if (pace != null && pace["stage"].newer(PACE_STAGES)) w.with("pace", pace.with("stage", JsonPrimitive("unknown"))) else w
                    }))
                }))
            }
            (b["alerts"] as? JsonArray)?.let { alerts ->
                b = b.with("alerts", JsonArray(alerts.filterNot { (it as? JsonObject)?.get("kind").newer(ALERT_KINDS) }))
            }
            b
        }
        else -> body
    }
}
