// In the root package, as buildSrc's VersionCode.kt is.
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Android versionCode (#551): above what Play has seen, and in release order. */
class VersionCodeTest {
    @Test
    fun aboveTheCodePlayAlreadyHas() {
        // 1.0.0-rc.1 under the formula before #551, uploaded to Play's closed test.
        assertTrue(versionCodeOf("0.1.0") > 1_000_001)
        assertTrue(versionCodeOf("0.0.1-rc.1") > 1_000_001)
    }

    @Test
    fun codesIncreaseWithVersions() {
        val inOrder = listOf("0.1.0-rc.1", "0.1.0-rc.2", "0.1.0", "0.1.1", "0.2.0-rc.1", "0.2.0", "0.99.99", "1.0.0-rc.1", "1.0.0", "1.2.3", "2.0.0")
        val codes = inOrder.map(::versionCodeOf)
        assertEquals(codes.sorted(), codes)
        assertEquals(codes.size, codes.toSet().size)
    }
}
