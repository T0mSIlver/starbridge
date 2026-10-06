package dev.starbridge.app

import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontWeight
import dev.starbridge.app.ui.inbox.findWords
import dev.starbridge.app.ui.inbox.highlight
import dev.starbridge.app.ui.inbox.matches
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Find's rules, shared with the web's `matches` and `Hit`.
class FindTest {
    @Test fun everyWordAnywhereIgnoringCase() {
        val texts = listOf("MacBook", "starbridge", "Which landing hero should I keep?", null)
        assertTrue(matches(findWords("  LANDING  macbook "), texts))
        assertFalse(matches(findWords("landing vidtheque"), texts))
    }

    @Test fun marksEachWordWhereverItAppears() {
        val style = SpanStyle(fontWeight = FontWeight.SemiBold)
        val marked = highlight("Ship the landing copy, landing first", findWords("Landing ship"), style)
        assertEquals(listOf(0 to 4, 9 to 16, 23 to 30), marked.spanStyles.map { it.start to it.end })
    }
}
