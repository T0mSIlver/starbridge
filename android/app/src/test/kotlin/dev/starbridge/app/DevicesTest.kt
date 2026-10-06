package dev.starbridge.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.util.TimeZone

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class DevicesTest {
    @get:Rule val compose = createComposeRule()

    private val zone = TimeZone.getDefault()

    @Before fun utc() = TimeZone.setDefault(TimeZone.getTimeZone("UTC"))

    @After fun restore() = TimeZone.setDefault(zone)

    @Test fun aMachinePairedAgainReadsApartFromItsOldPairing() {
        val members = listOf(
            Member("m1", "sandbox", Kind.Machine, Instant.parse("2026-10-06T09:32:00Z")),
            Member("m2", "sandbox", Kind.Machine, Instant.parse("2026-10-06T10:32:00Z")),
            Member("m3", "mac mini", Kind.Machine, Instant.parse("2026-10-06T11:32:00Z")),
        )
        compose.setContent { StarbridgeTheme { DevicesScreen(members, Instant.now(), DeviceActions({}, {}, {}, {}, {})) } }
        compose.onNodeWithText("Machine · added Oct 6, 09:32").assertExists()
        compose.onNodeWithText("Machine · added Oct 6, 10:32").assertExists()
        compose.onAllNodesWithText("Machine · added Oct 6").assertCountEquals(1)
    }
}
