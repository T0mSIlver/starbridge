package dev.starbridge.app.widget

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.ExperimentalGlanceApi
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Pace
import dev.starbridge.app.data.QuotaSettings
import dev.starbridge.app.data.QuotaWindow
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/**
 * The widgets on sample data at their sizes, on a wallpaper-like ground, as the launcher applies
 * their RemoteViews: for screenshots on an emulator (#894).
 * `am start -n dev.starbridge.app/.widget.WidgetShotsActivity [--es colours Wallpaper]`; `--es pin
 * questions|quotas` asks the launcher to place the real one instead.
 */
class WidgetShotsActivity : Activity() {
    private val scope = MainScope()

    private class Sample(val content: @Composable () -> Unit) : GlanceAppWidget() {
        override val sizeMode = SizeMode.Exact
        override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { content() }
    }

    @OptIn(ExperimentalGlanceApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent.getStringExtra("pin")?.let { pin ->
            scope.launch {
                val manager = androidx.glance.appwidget.GlanceAppWidgetManager(this@WidgetShotsActivity)
                if (pin == "quotas") manager.requestPinGlanceAppWidget(QuotasWidgetReceiver::class.java)
                else manager.requestPinGlanceAppWidget(QuestionsWidgetReceiver::class.java)
                finish()
            }
            return
        }
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val p = Palette.of(if (intent.getStringExtra("colours") == "Wallpaper") Colours.Wallpaper else Colours.Starbridge)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, px(40f), 0, 0)
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                if (dark) intArrayOf(0xFF1E2A33.toInt(), 0xFF2B2235.toInt(), 0xFF141A1F.toInt())
                else intArrayOf(0xFFCFE0EA.toInt(), 0xFFE8D9E6.toInt(), 0xFFDCE6D5.toInt()),
            )
        }
        setContentView(root)
        window.insetsController?.hide(WindowInsets.Type.systemBars())
        val now = Instant.now()
        val rows = QuotaRow.of(windows(now), QuotaSettings(), now, h24 = true)
        val calm = QuotaRow.of(windows(now).filter { it.pace !is Pace.RunsOut }, QuotaSettings(), now, h24 = true)
        val small = DpSize(172.dp, 172.dp)
        val wide = DpSize(356.dp, 172.dp)
        val lines: List<List<Pair<String, Pair<Sample, DpSize>>>> = listOf(
            listOf(
                "Needs you, waiting" to (Sample { NeedsYouWidget(NeedsYou(open = 3, waiting = 2), p) } to small),
                "Needs you, none waiting" to (Sample { NeedsYouWidget(NeedsYou(open = 1, waiting = 0), p) } to small),
            ),
            listOf(
                "Quotas 2×2" to (Sample { QuotasWidget(rows, p) } to small),
                "Quotas 2×2, on pace" to (Sample { QuotasWidget(calm, p) } to small),
            ),
            listOf("Quotas 4×2" to (Sample { QuotasWidget(rows, p) } to wide)),
        )
        scope.launch {
            lines.forEach { line ->
                val row = LinearLayout(this@WidgetShotsActivity)
                root.addView(row, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(20f) })
                line.forEachIndexed { i, (name, sample) ->
                    val (widget, size) = sample
                    val cell = LinearLayout(this@WidgetShotsActivity).apply { orientation = LinearLayout.VERTICAL }
                    cell.addView(
                        TextView(this@WidgetShotsActivity).apply {
                            text = name
                            setTextColor(if (dark) 0x99FFFFFF.toInt() else 0x99000000.toInt())
                            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                        },
                        LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(4f); leftMargin = px(4f) },
                    )
                    val frame = FrameLayout(this@WidgetShotsActivity)
                    cell.addView(frame, LinearLayout.LayoutParams(px(size.width.value), px(size.height.value)))
                    row.addView(cell, LinearLayout.LayoutParams(-2, -2).apply { if (i > 0) leftMargin = px(12f) })
                    val view = widget.compose(this@WidgetShotsActivity, size = size).apply(this@WidgetShotsActivity, frame)
                    view.clipToOutline = true
                    frame.addView(view, FrameLayout.LayoutParams(-1, -1))
                }
            }
        }
    }

    private fun windows(now: Instant) = listOf(
        QuotaWindow("c5", "Claude", "5-hour", 42, now.plus(Duration.ofMinutes(150)), Pace.Even, steadyPercent = 50),
        QuotaWindow("cw", "Claude", "Weekly", 68, now.plus(Duration.ofDays(2)), Pace.RunsOut(now.plus(Duration.ofHours(30))), steadyPercent = 55),
        QuotaWindow("x5", "Codex", "5-hour", 23, now.plus(Duration.ofMinutes(200)), Pace.Even, steadyPercent = 40),
        QuotaWindow("xw", "Codex", "Weekly", 51, now.plus(Duration.ofDays(4)), Pace.Even, steadyPercent = 47),
    )

    private fun px(dp: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics).toInt()

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}
