package dev.starbridge.app

import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.Secrets
import dev.starbridge.app.data.Vault
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Saved files carry their format, and one this app cannot read is kept, never overwritten (#473). */
class DiskTest {
    private val identity = object : Vault {
        override fun wrap(plain: ByteArray) = plain
        override fun unwrap(wrapped: ByteArray) = wrapped
    }

    @Test
    fun writesItsFormatAndKeepsAFileItCannotRead() {
        val dir = Files.createTempDirectory("starbridge").toFile()
        val disk = Disk(dir, identity)
        disk.save(Saved("https://starbridge.run"))
        disk.save(Secrets(session = "s"))
        assertTrue(File(dir, "state.bin").readText().contains("\"v\":1"))
        assertTrue(File(dir, "secrets.bin").readText().contains("\"v\":1"))

        val newer = """{"v":2,"session":"s"}"""
        File(dir, "secrets.bin").writeText(newer)
        File(dir, "state.bin").writeText("not json")
        val again = Disk(dir, identity)
        assertNull(again.saved())
        assertEquals(Secrets(), again.secrets())
        assertEquals(listOf("state.bin", "secrets.bin"), again.unreadable)
        assertEquals(newer, File(dir, "secrets.bin.unreadable").readText())
        assertEquals("not json", File(dir, "state.bin.unreadable").readText())
    }
}
