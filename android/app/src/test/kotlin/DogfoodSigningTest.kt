// In the root package, as buildSrc's DogfoodSigning.kt is.
import java.io.File
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Debug builds sign with the release key only when the maintainer's local.properties asks (#569). */
class DogfoodSigningTest {
    @get:Rule val tmp = TemporaryFolder()
    private val home by lazy {
        tmp.root.also { File(it, ".config/starbridge/secrets").mkdirs() }
    }
    private fun secrets(vararg names: String) = names.forEach { File(home, ".config/starbridge/secrets/$it").writeText("x") }
    private fun props(vararg pairs: Pair<String, String>) = Properties().apply { pairs.forEach { (k, v) -> setProperty(k, v) } }

    @Test
    fun debugBuildsKeepTheDebugKeyByDefault() {
        assertNull(dogfoodKey(props(), null, home))
        assertNull(dogfoodKey(props("sdk.dir" to "/sdk"), null, home))
        assertNull(dogfoodKey(props("starbridge.dogfoodSigning" to "false"), null, home))
    }

    @Test
    fun theLocalPropertyPicksTheReleaseKey() {
        secrets("release.jks", "release-keystore-password")
        val key = dogfoodKey(props("starbridge.dogfoodSigning" to "true"), null, home)
        assertEquals(File(home, ".config/starbridge/secrets/release.jks"), key?.store)
        assertEquals(File(home, ".config/starbridge/secrets/release-keystore-password"), key?.passwordFile)
        assertEquals("starbridge", key?.alias)
    }

    @Test
    fun aMissingSecretFailsTheBuildByName() {
        secrets("release.jks")
        val e = assertThrows(IllegalStateException::class.java) {
            dogfoodKey(props("starbridge.dogfoodSigning" to "true"), null, home)
        }
        assertTrue(e.message!!.contains("release-keystore-password"))
    }

    @Test
    fun ciRefusesIt() {
        assertThrows(IllegalStateException::class.java) {
            dogfoodKey(props("starbridge.dogfoodSigning" to "true"), "true", home)
        }
    }
}
