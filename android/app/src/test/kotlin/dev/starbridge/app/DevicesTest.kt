package dev.starbridge.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import dev.starbridge.app.data.Kind
import dev.starbridge.app.data.Member
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.day
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class DevicesTest {
    @get:Rule val compose = createComposeRule()

    @Test fun aMachinePairedAgainReadsApartFromItsOldPairing() {
        val members = listOf(
            Member("m1", "sandbox", Kind.Machine, Instant.parse("2026-10-06T09:32:00Z")),
            Member("m2", "sandbox", Kind.Machine, Instant.parse("2026-10-06T10:32:00Z")),
            Member("m3", "mac mini", Kind.Machine, Instant.parse("2026-10-06T11:32:00Z")),
        )
        compose.setContent { StarbridgeTheme { DevicesScreen(members, Instant.now(), DeviceActions({}, {}, {}, {}, {})) } }
        // In the JVM's own zone: setting it here would move other tests' clock times.
        fun added(m: Member) = "Machine · added ${day(m.addedAt)}"
        compose.onNodeWithText("${added(members[0])}, ${clock(members[0].addedAt, true)}").assertExists()
        compose.onNodeWithText("${added(members[1])}, ${clock(members[1].addedAt, true)}").assertExists()
        compose.onAllNodesWithText(added(members[2])).assertCountEquals(1)
    }
}
