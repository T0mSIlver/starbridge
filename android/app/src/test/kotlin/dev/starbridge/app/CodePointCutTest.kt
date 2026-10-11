package dev.starbridge.app

import dev.starbridge.app.protocol.takeCodePoints
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// A cut at a length never splits an emoji's surrogate pair, which signing refuses (#1173).
class CodePointCutTest {
    @Test fun cutsAtCodePointsNotUtf16Units() {
        val text = "a".repeat(3) + "😀".repeat(2)
        assertEquals("aaa😀", text.takeCodePoints(4))
        assertEquals(text, text.takeCodePoints(5))
        // Kotlin's take(4) would end in a lone high surrogate.
        assertTrue(Character.isHighSurrogate(text.take(4).last()))
    }
}
