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

    @Test
    fun mainBuildsSitBetweenTheRcsAndTheFinal() {
        // Under 0.1.7-rc.2: above every rc of 0.1.7, below its final.
        assertEquals(2_010_750, mainVersionCodeOf("0.1.7-rc.2", after = 0))
        assertTrue(mainVersionCodeOf("0.1.7-rc.2", after = 0) > versionCodeOf("0.1.7-rc.49"))
        assertTrue(mainVersionCodeOf("0.1.7-rc.2", after = 2_010_797) < versionCodeOf("0.1.7"))
        // Each build takes the slot after the track's last, across rcs of the version.
        assertEquals(2_010_756, mainVersionCodeOf("0.1.7-rc.3", after = 2_010_755))
        // After the final, main is the next patch: above 0.1.7 and 0.1.8's rcs.
        assertEquals(2_010_850, mainVersionCodeOf("0.1.7", after = 2_010_760))
        // An rc whose final is tagged (main keeps 0.1.7-rc.N after promotion): the next patch's
        // slots, above the final (#1731).
        assertEquals(2_010_850, mainVersionCodeOf("0.1.7-rc.2", after = 2_010_797, finalTagged = true))
        assertTrue(mainVersionCodeOf("0.1.7-rc.2", after = 0, finalTagged = true) > versionCodeOf("0.1.7"))
        assertEquals(2_010_851, mainVersionCodeOf("0.1.7-rc.2", after = 2_010_850, finalTagged = true))
    }

    @Test(expected = IllegalArgumentException::class)
    fun mainBuildsStopWhenTheVersionsSlotsAreSpent() {
        mainVersionCodeOf("0.1.7-rc.2", after = 2_010_798)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rcsStopAt49() {
        versionCodeOf("0.1.7-rc.50")
    }
}
