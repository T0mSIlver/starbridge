// In the root package, as buildSrc's DogfoodSigning.kt is.
import java.io.File
import java.util.Properties
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** Debug builds sign with the release key only when the maintainer's local.properties asks (#569). */
class DogfoodSigningTest {
    private val home = File("/home/someone")
    private fun props(vararg pairs: Pair<String, String>) = Properties().apply { pairs.forEach { (k, v) -> setProperty(k, v) } }

    @Test
    fun debugBuildsKeepTheDebugKeyByDefault() {
        assertNull(dogfoodKey(props(), emptyMap(), home))
        assertNull(dogfoodKey(props("sdk.dir" to "/sdk"), emptyMap(), home))
        assertNull(dogfoodKey(props("starbridge.dogfoodSigning" to "false"), emptyMap(), home))
    }

    @Test
    fun theLocalPropertyPicksTheReleaseKey() {
        val key = dogfoodKey(props("starbridge.dogfoodSigning" to "true"), emptyMap(), home)
        assertEquals(File(home, ".config/starbridge/secrets/release.jks"), key?.store)
        assertEquals(File(home, ".config/starbridge/secrets/release-keystore-password"), key?.passwordFile)
        assertEquals("starbridge", key?.alias)
    }

    @Test
    fun ciRefusesIt() {
        assertThrows(IllegalStateException::class.java) {
            dogfoodKey(props("starbridge.dogfoodSigning" to "true"), mapOf("CI" to "true"), home)
        }
    }
}
