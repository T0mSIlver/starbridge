package dev.starbridge.app

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Looper
import android.widget.ScrollView
import androidx.activity.ComponentActivity
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.Prefs
import dev.starbridge.app.push.Notifier
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import java.time.Instant

// The shade as Android draws it: each notification's expanded view, inflated from the system's
// own templates. A question its agent waits on, one it works around, and a prompt (#191).
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class NotificationScreenshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun schemes() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))

        // One zone, as ScreenshotTest's: Robolectric restores the zone it found at the first test.
        init {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"))
        }
    }

    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val now = Instant.parse("2026-10-04T14:00:00Z")
    private val fake = Fake(now)

    private fun build(context: Context): View {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val notifier = Notifier(app, Prefs(app))
        notifier.prompt(fake.prompts.first())
        notifier.prompt(fake.longPrompt)
        fake.decisions.filter { it.id == "d2" || it.id == "d1" }.forEach { notifier.decision(it) }
        val posted = shadowOf(app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).allNotifications
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(if (dark) Color.BLACK else Color.parseColor("#DCDCDC"))
            setPadding(24, 24, 24, 24)
        }
        // As the shade ranks them: what blocks an agent first.
        posted.sortedBy { listOf(Notifier.PROMPTS, Notifier.WAITING, Notifier.QUESTIONS).indexOf(it.channelId) }.forEach { n ->
            val card = FrameLayout(context).apply {
                setBackgroundColor(if (dark) Color.parseColor("#171717") else Color.WHITE)
                setPadding(0, 16, 0, 16)
            }
            val views = Notification.Builder.recoverBuilder(context, n).createBigContentView()
            card.addView(views.apply(context, card))
            column.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 8 })
        }
        return column
    }

    @Test fun notifications() {
        // The header's time and chronometer read Robolectric's clock, which starts in 1970.
        ShadowSystemClock.advanceBy(Duration.ofMillis(now.toEpochMilli()))
        RuntimeEnvironment.setQualifiers(if (dark) "+night" else "+notnight")
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val view = build(activity)
        activity.setContentView(ScrollView(activity).apply { addView(view) })
        shadowOf(Looper.getMainLooper()).idle()
        view.captureRoboImage("screenshots/notifications-${if (dark) "dark" else "light"}.png")
    }

    // A running run whose title runs past the line, collapsed then expanded: the step count leads
    // the title, so its ellipsis can't hide it, and the collapsed view drops the text (#826).
    @Test fun runs() {
        ShadowSystemClock.advanceBy(Duration.ofMillis(now.toEpochMilli()))
        RuntimeEnvironment.setQualifiers(if (dark) "+night" else "+notnight")
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        // `at` is the real clock's: the notifier reads it to tell a live run from a lost one.
        val run = fake.runs.first().copy(title = "Android end-to-end suite on the emulator, all flows", startedAt = now.minusSeconds(372), at = Instant.now())
        Notifier(app, Prefs(app)).run(run)
        val n = shadowOf(app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).allNotifications.single()
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(if (dark) Color.BLACK else Color.parseColor("#DCDCDC"))
            setPadding(24, 24, 24, 24)
        }
        val builder = Notification.Builder.recoverBuilder(activity, n)
        // The collapsed template fills its parent: with a progress bar, the shade gives it 80 dp.
        val collapsed = (80 * activity.resources.displayMetrics.density).toInt()
        listOf(builder.createContentView() to collapsed, builder.createBigContentView() to ViewGroup.LayoutParams.WRAP_CONTENT).forEach { (views, height) ->
            val card = FrameLayout(activity).apply {
                setBackgroundColor(if (dark) Color.parseColor("#171717") else Color.WHITE)
                setPadding(0, 16, 0, 16)
            }
            card.addView(views.apply(activity, card), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height))
            column.addView(card, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = 8 })
        }
        activity.setContentView(ScrollView(activity).apply { addView(column) })
        shadowOf(Looper.getMainLooper()).idle()
        column.captureRoboImage("screenshots/notification-run-${if (dark) "dark" else "light"}.png")
    }
}
