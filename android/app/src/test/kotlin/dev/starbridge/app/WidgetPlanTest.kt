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
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
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
import dev.starbridge.app.widget.Palette
import dev.starbridge.app.widget.Plan
import dev.starbridge.app.widget.PlanPicker
import dev.starbridge.app.widget.QuotaRow
import dev.starbridge.app.widget.QuotasWidget
import dev.starbridge.app.widget.planChoices
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import java.time.Instant

// The Quotas widget's plan (#907): the picker and widgets showing different plans, light and dark.
// Written to app/screenshots/widgets/.
@RunWith(ParameterizedRobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class WidgetPlanTest(private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "dark={0}")
        fun cases() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))
    }

    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-09T14:00:00Z")
    private val scheme get() = if (dark) "dark" else "light"

    private val windows = listOf(
        QuotaWindow("c5", "Claude", "5-hour", 42, now.plus(Duration.ofMinutes(150)), Pace.Even, steadyPercent = 50),
        QuotaWindow("cw", "Claude", "Weekly", 68, now.plus(Duration.ofDays(2)), Pace.RunsOut(now.plus(Duration.ofHours(30))), steadyPercent = 55),
        QuotaWindow("x5", "Codex", "5-hour", 23, now.plus(Duration.ofMinutes(200)), Pace.Even, steadyPercent = 40),
        QuotaWindow("xw", "Codex", "Weekly", 51, now.plus(Duration.ofDays(4)), Pace.Even, steadyPercent = 47),
        QuotaWindow("z5", "z.ai", "5-hour", 12, now.plus(Duration.ofMinutes(38)), Pace.Unused(86), steadyPercent = 88),
    )

    private val codex = Plan("Codex", null)

    @Test fun picker() {
        compose.setContent {
            StarbridgeTheme(darkTheme = dark, colours = Colours.Starbridge) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
                    PlanPicker(planChoices(windows, QuotaSettings(), now, codex), codex, signedIn = true) {}
                }
            }
        }
        compose.onRoot().captureRoboImage("screenshots/widgets/picker-$scheme.png")
    }

    private class Sample(val content: @Composable () -> Unit) : GlanceAppWidget() {
        override val sizeMode = SizeMode.Exact
        override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { content() }
    }

    @OptIn(ExperimentalGlanceApi::class)
    @Test fun widgets() {
        val base = ApplicationProvider.getApplicationContext<Context>()
        val context = base.createConfigurationContext(
            Configuration(base.resources.configuration).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            },
        )
        val p = Palette.of(Colours.Starbridge)
        fun rows(plan: Plan?) = QuotaRow.of(windows, QuotaSettings(), now, h24 = true, plan = plan)
        val small = DpSize(172.dp, 172.dp)
        val wide = DpSize(356.dp, 172.dp)
        val gone = Plan("Gemini", null)
        val lines = listOf(
            listOf(Sample { QuotasWidget(rows(Plan("Claude", null)), p, Plan("Claude", null)) } to small, Sample { QuotasWidget(rows(codex), p, codex) } to small),
            listOf(Sample { QuotasWidget(rows(codex), p, codex) } to wide),
            listOf(Sample { QuotasWidget(rows(null), p) } to small, Sample { QuotasWidget(rows(gone), p, gone) } to small),
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
        compose.onRoot().captureRoboImage("screenshots/widgets/plans-$scheme.png")
    }
}
