package dev.starbridge.app

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Android's ICU regex rejects the (?U) flag that Java's accepts, so a pattern with it passes every
 * unit test and throws on a phone (#1002). Spell the character class out instead.
 */
class RegexFlagsTest {
    @Test fun noUnicodeClassFlag() {
        val found = File("src/main").walk()
            .filter { it.isFile && it.extension in setOf("kt", "java") && "(?U)" in it.readText() }
            .map { it.path }.toList()
        assertEquals(emptyList<String>(), found)
    }
}
