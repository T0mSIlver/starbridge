package dev.starbridge.app

import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.Saved
import dev.starbridge.app.data.SavedDecision
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

        // Keys without the state they belong to would act as a device with no pin: both go aside.
        val newer = """{"v":2,"server":"https://starbridge.run"}"""
        File(dir, "state.bin").writeText(newer)
        val again = Disk(dir, identity)
        assertEquals(null to Secrets(), again.load())
        assertEquals(listOf("state.bin"), again.unreadable)
        val kept = dir.listFiles()!!.map { it.name }.sorted()
        assertTrue(kept.any { it.startsWith("state.bin.unreadable-") } && kept.any { it.startsWith("secrets.bin.unreadable-") })
        assertEquals(newer, dir.listFiles()!!.single { it.name.startsWith("state.bin.unreadable-") }.readText())
        assertNull(again.saved())
    }

    @Test
    fun keepsTheSignedTextWithFieldsThisAppDoesNotKnow() {
        // A newer machine's field survives a save: a later app reads it from the same record (#476).
        val text = """{"v":1,"id":"d_1","to":["phone"],"createdAt":"2026-10-06T10:00:00Z","question":"Ship?","context":"","options":["Yes","No"],"recommended":"Yes","source":{"machine":"devbox","project":"p","session":"s"},"later":{"x":1}}"""
        val dir = Files.createTempDirectory("starbridge").toFile()
        Disk(dir, identity).save(Saved("https://starbridge.run", decisions = listOf(SavedDecision("m_1", text))))
        val kept = Disk(dir, identity).load().first!!.decisions.single()
        assertEquals(text, kept.text)
        assertEquals("Ship?", kept.body.question)
    }
}
