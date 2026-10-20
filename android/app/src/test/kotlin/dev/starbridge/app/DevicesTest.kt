package dev.starbridge.app

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import dev.starbridge.app.data.Approval
import dev.starbridge.app.data.Kind
import dev.starbridge.app.ui.devices.PairLinkScreen
import dev.starbridge.app.data.Member
import dev.starbridge.app.protocol.CHECK_CONFIRM_MS
import dev.starbridge.app.ui.devices.DeviceActions
import dev.starbridge.app.ui.clock
import dev.starbridge.app.ui.day
import dev.starbridge.app.ui.devices.DevicesScreen
import dev.starbridge.app.ui.theme.StarbridgeTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Assert.assertEquals
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

    @Test fun aMachineShowsItsCheckCodeOnlyWhileItsPairingWaitsForIt() {
        val added = Instant.parse("2026-10-09T09:00:00Z")
        val members = listOf(Member("m1", "devbox", Kind.Machine, added, check = "HYB9-MDSM-H3N5-PVAX"))
        var now by mutableStateOf(added.plusMillis(CHECK_CONFIRM_MS - 1))
        compose.setContent { StarbridgeTheme { DevicesScreen(members, now, DeviceActions({}, {}, {}, {}, {})) } }
        compose.onNodeWithText("Same code as on the machine? HYB9-MDSM-H3N5-PVAX").assertExists()
        now = added.plusMillis(CHECK_CONFIRM_MS)
        compose.onAllNodesWithText("HYB9-MDSM-H3N5-PVAX", substring = true).assertCountEquals(0)
    }

    // A pairing link comes from anyone: Approve asks once more, naming the device (internal audit 2026-10-14).
    @Test fun aPairingLinkAsksBeforeItApproves() {
        var approved = 0
        compose.setContent {
            StarbridgeTheme {
                PairLinkScreen(Approval.Found("sandbox", Kind.Machine, "ABCD-EFGH"), DeviceActions({}, { approved++ }, {}, {}, {}))
            }
        }
        compose.onNodeWithText("Approve", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Approve sandbox from this link?").assertIsDisplayed()
        assertEquals(0, approved)
        compose.onAllNodesWithText("Cancel", useUnmergedTree = true).get(1).performClick()
        assertEquals(0, approved)
        compose.onNodeWithText("Approve", useUnmergedTree = true).performClick()
        compose.onAllNodesWithText("Approve", useUnmergedTree = true).get(1).performClick()
        assertEquals(1, approved)
    }

    /** A phone or browser by link: Approve waits for the last group of the code it shows (#2183). */
    @Test fun aDeviceByLinkWaitsForTheLastGroupOfItsCode() {
        var approved = 0
        val code = "0123-4567-89AB-CDEF-GHJK-MN01"
        compose.setContent {
            StarbridgeTheme {
                PairLinkScreen(Approval.Found("Pixel 9", Kind.Device, code), DeviceActions({}, { approved++ }, {}, {}, {}))
            }
        }
        // The link carries the code: the screen doesn't show what to type.
        compose.onAllNodesWithText(code, substring = true).assertCountEquals(0)
        compose.onNodeWithText("Type the last 4 characters of the code Pixel 9 shows.").assertIsDisplayed()
        compose.onNodeWithText("Last 4 characters").performTextInput("ghjk")
        compose.onNodeWithText("Approve", useUnmergedTree = true).performClick()
        assertEquals(0, approved)
        compose.onNodeWithText("ghjk").performTextClearance()
        compose.onNodeWithText("Last 4 characters").performTextInput("mnoi")
        compose.onNodeWithText("Approve", useUnmergedTree = true).performClick()
        // No second confirm: the typed group is the proof.
        assertEquals(1, approved)
    }
}
