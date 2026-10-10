package dev.starbridge.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.starbridge.app.protocol.ProtocolJson
import dev.starbridge.app.protocol.contextText
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * context.json on Android's runtime, whose regex engine is ICU's: the JVM unit tests run Java's,
 * which accepted a flag that ICU rejects (#1002). ProtocolVectorsTest checks the spans.
 * Run with `./gradlew connectedDebugAndroidTest` on an emulator or a phone.
 */
@RunWith(AndroidJUnit4::class)
class ContextTextDeviceTest {
    @Test fun contextVectors() {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val v = ProtocolJson.parseToJsonElement(assets.open("context.json").bufferedReader().readText()).jsonObject
        for (c in v.getValue("cases").jsonArray.map { it.jsonObject }) {
            fun str(key: String) = c.getValue(key).jsonPrimitive.content
            assertEquals(str("name"), str("plain"), contextText(str("text")))
        }
    }
}
