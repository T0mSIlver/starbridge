package dev.starbridge.app

import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.glance.ExperimentalGlanceApi
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import dev.starbridge.app.ui.theme.StarbridgeTheme
import dev.starbridge.app.widget.Choice
import dev.starbridge.app.widget.Palette
import dev.starbridge.app.widget.Plan
import dev.starbridge.app.widget.QuotaPicker
import dev.starbridge.app.widget.QuotaRow
import dev.starbridge.app.widget.QuotasWidget
import dev.starbridge.app.widget.chosen
import dev.starbridge.app.widget.pickerPlans
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import java.time.Instant

// Each Quotas widget shows the quotas picked for it (#907). Screenshots go to
// app/screenshots/widgets/; android/docs/widgets/ keeps copies.
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class QuotasWidgetTest {
    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-09T14:00:00Z")
    private val claude = Plan("Claude", null)
    private val codex = Plan("Codex", null)

    private val windows = listOf(
        QuotaWindow("c5", "Claude", "5-hour", 42, now.plus(Duration.ofMinutes(150)), Pace.Even, steadyPercent = 50),
        QuotaWindow("cw", "Claude", "Weekly", 68, now.plus(Duration.ofDays(2)), Pace.RunsOut(now.plus(Duration.ofHours(30))), steadyPercent = 55),
        QuotaWindow("co", "Claude", "Opus", 30, now.plus(Duration.ofDays(2)), Pace.Even, steadyPercent = 55),
        QuotaWindow("x5", "Codex", "5-hour", 23, now.plus(Duration.ofMinutes(200)), Pace.Even, steadyPercent = 40),
        QuotaWindow("xw", "Codex", "Weekly", 51, now.plus(Duration.ofDays(4)), Pace.Even, steadyPercent = 47),
    )

    private fun rows(plan: Plan?, from: List<QuotaWindow> = windows) = QuotaRow.of(from, QuotaSettings(), now, h24 = true, plan = plan)

    @Test fun storedChoiceRoundTrips() {
        val state = mutablePreferencesOf()
        val choice = Choice(Plan("Claude", "mac"), listOf("Weekly", "Opus"))
        Choice.write(state, choice)
        assertEquals(choice, Choice.read(state))
        // Back to "Running out first": nothing of the old choice stays.
        Choice.write(state, null)
        assertEquals(null, Choice.read(state))
        assertEquals(0, state.asMap().size)
    }

    @Test fun showsThePickedQuotaFillingAWiderWidgetFromItsPlan() {
        val weekly = Choice(claude, listOf("Weekly"))
        assertEquals(listOf("Weekly"), rows(claude).chosen(weekly, 1).map { it.window.window })
        // Picked on a 2×2, then widened: the plan's next quota in the Quotas screen's order joins it.
        assertEquals(listOf("Weekly", "5-hour"), rows(claude).chosen(weekly, 2).map { it.window.window })
    }

    @Test fun aQuotaThatStopsReportingKeepsItsChoiceAndShowsNone() {
        val opus = Choice(claude, listOf("Opus"))
        assertEquals(emptyList<QuotaRow>(), rows(claude, windows.filter { it.id != "co" }).chosen(opus, 2))
        // A plan that is gone keeps its place in the picker, so the widget's choice still shows.
        val plans = pickerPlans(windows.filter { it.provider != "Claude" }, QuotaSettings(), now, true, opus)
        assertEquals(listOf(codex, claude), plans.map { it.plan })
        assertEquals(0, plans.last().rows.size)
    }

    @Test fun aWideWidgetTicksTwoQuotasOfAPlanWithMore() {
        var picked: Choice? = null
        compose.setContent {
            StarbridgeTheme { QuotaPicker(pickerPlans(windows, QuotaSettings(), now, true, null), wide = true, chosen = null, signedIn = true) { picked = it } }
        }
        compose.onNodeWithText("Opus").performClick()
        assertEquals(null, picked)
        compose.onNodeWithText("Weekly", substring = false).performClick()
        assertEquals(Choice(claude, listOf("Opus", "Weekly")), picked)
    }

    private fun picker(wide: Boolean, dark: Boolean, chosen: Choice?) {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark, colours = Colours.Starbridge) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
                    QuotaPicker(pickerPlans(windows, QuotaSettings(), now, true, chosen), wide, chosen, signedIn = true) {}
                }
            }
        }
        compose.onRoot().captureRoboImage("screenshots/widgets/picker-${if (wide) "4x2" else "2x2"}-${if (dark) "dark" else "light"}.png")
    }

    @Test fun picker2x2Light() = picker(wide = false, dark = false, Choice(codex, listOf("Weekly")))
    @Test fun picker2x2Dark() = picker(wide = false, dark = true, Choice(codex, listOf("Weekly")))
    @Test fun picker4x2Light() = picker(wide = true, dark = false, Choice(codex, listOf("5-hour", "Weekly")))

    private class Sample(val content: @Composable () -> Unit) : GlanceAppWidget() {
        override val sizeMode = SizeMode.Exact
        override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { content() }
    }

    @OptIn(ExperimentalGlanceApi::class)
    private fun widgets(dark: Boolean) {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val context = base.createConfigurationContext(
            Configuration(base.resources.configuration).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            },
        )
        val p = Palette.of(Colours.Starbridge)
        val small = DpSize(172.dp, 172.dp)
        val wide = DpSize(356.dp, 172.dp)
        fun widget(choice: Choice?, from: List<QuotaWindow> = windows) = Sample { QuotasWidget(rows(choice?.plan, from), p, choice) }
        val opus = Choice(claude, listOf("Opus"))
        val lines = listOf(
            listOf(widget(Choice(claude, listOf("5-hour"))) to small, widget(Choice(codex, listOf("Weekly"))) to small),
            listOf(widget(Choice(claude, listOf("Weekly", "Opus"))) to wide),
            listOf(widget(null) to small, widget(opus, windows.filter { it.id != "co" }) to small),
        )
        val density = context.resources.displayMetrics.density
        fun px(dp: Float) = (dp * density).toInt()
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20f), px(20f), px(20f), px(20f))
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                if (dark) intArrayOf(0xFF1E2A33.toInt(), 0xFF2B2235.toInt(), 0xFF141A1F.toInt())
                else intArrayOf(0xFFCFE0EA.toInt(), 0xFFE8D9E6.toInt(), 0xFFDCE6D5.toInt()),
            )
        }
        runBlocking {
            lines.forEach { line ->
                val row = LinearLayout(context)
                root.addView(row, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(16f) })
                line.forEachIndexed { i, (widget, size) ->
                    val frame = FrameLayout(context)
                    row.addView(frame, LinearLayout.LayoutParams(px(size.width.value), px(size.height.value)).apply { if (i > 0) leftMargin = px(12f) })
                    val view = widget.compose(context, size = size).apply(context, frame)
                    view.clipToOutline = true
                    frame.addView(view, FrameLayout.LayoutParams(-1, -1))
                }
            }
        }
        // Roborazzi captures views in an activity: the compose rule's.
        compose.setContent { AndroidView(factory = { root }, modifier = Modifier.fillMaxWidth()) }
        compose.onRoot().captureRoboImage("screenshots/widgets/widgets-${if (dark) "dark" else "light"}.png")
    }

    @Test fun widgetsLight() = widgets(dark = false)
    @Test fun widgetsDark() = widgets(dark = true)
}
