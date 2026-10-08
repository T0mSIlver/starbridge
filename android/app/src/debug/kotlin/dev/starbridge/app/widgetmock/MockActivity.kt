package dev.starbridge.app.widgetmock

import android.app.Activity
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.ExperimentalGlanceApi
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.compose
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/**
 * Lays out one candidate widget at its sizes on a wallpaper-like ground, for screenshots (#894):
 * `am start -n dev.starbridge.app/.widgetmock.MockActivity --es purpose questions|quotas|runs`.
 * Each widget is Glance's own RemoteViews, applied as the launcher would.
 */
class MockActivity : Activity() {
    private val scope = MainScope()

    @OptIn(ExperimentalGlanceApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val purpose = intent.getStringExtra("purpose") ?: "questions"
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, px(40), 0, 0)
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                if (dark) intArrayOf(0xFF1E2A33.toInt(), 0xFF2B2235.toInt(), 0xFF141A1F.toInt())
                else intArrayOf(0xFFCFE0EA.toInt(), 0xFFE8D9E6.toInt(), 0xFFDCE6D5.toInt()),
            )
        }
        setContentView(root)
        window.insetsController?.hide(WindowInsets.Type.systemBars())
        val small = DpSize(172.dp, 172.dp)
        val wide = DpSize(356.dp, 172.dp)
        val tall = DpSize(356.dp, 262.dp)
        val strip = DpSize(356.dp, 84.dp)
        val rows: List<List<Pair<GlanceAppWidget, DpSize>>> = when (purpose) {
            "quotas" -> listOf(listOf(QuotasMock() to small, QuotasMock(calm = true) to small), listOf(QuotasMock() to wide), listOf(QuotasMock() to tall))
            "runs" -> listOf(listOf(RunsMock() to small), listOf(RunsMock() to strip), listOf(RunsMock() to wide))
            else -> listOf(listOf(QuestionsMock() to small, QuestionsMock(rest = true) to small), listOf(QuestionsMock() to wide), listOf(QuestionsMock() to tall))
        }
        scope.launch {
            rows.forEach { row ->
                val line = LinearLayout(this@MockActivity).apply { orientation = LinearLayout.HORIZONTAL }
                root.addView(line, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(20) })
                row.forEachIndexed { i, (widget, size) ->
                    val label = TextView(this@MockActivity).apply {
                        text = "${if (size.width > 200.dp) 4 else 2}×${if (size.height < 120.dp) 1 else if (size.height < 200.dp) 2 else 3}"
                        setTextColor(if (dark) 0x99FFFFFF.toInt() else 0x99000000.toInt())
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                    }
                    val cell = LinearLayout(this@MockActivity).apply { orientation = LinearLayout.VERTICAL }
                    cell.addView(label, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(4); leftMargin = px(4) })
                    val frame = FrameLayout(this@MockActivity)
                    cell.addView(frame, LinearLayout.LayoutParams(px(size.width.value), px(size.height.value)))
                    line.addView(cell, LinearLayout.LayoutParams(-2, -2).apply { if (i > 0) leftMargin = px(12) })
                    val views = widget.compose(this@MockActivity, size = size)
                    val view: View = views.apply(this@MockActivity, frame)
                    view.clipToOutline = true
                    frame.addView(view, FrameLayout.LayoutParams(-1, -1))
                }
            }
        }
    }

    private fun px(dp: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, resources.displayMetrics).toInt()
    private fun px(dp: Int) = px(dp.toFloat())

    override fun onDestroy() {
        super.onDestroy()
        scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    }
}
