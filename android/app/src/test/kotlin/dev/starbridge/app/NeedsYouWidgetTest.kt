package dev.starbridge.app

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.glance.ExperimentalGlanceApi
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import dev.starbridge.app.data.Colours
import dev.starbridge.app.data.Decision
import dev.starbridge.app.data.Prompt
import dev.starbridge.app.data.Source
import dev.starbridge.app.widget.NeedsYou
import dev.starbridge.app.widget.NeedsYouWidget
import dev.starbridge.app.widget.Palette
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant

// The Needs you widget counts waiting permission prompts as the Inbox badge does (#1963).
// Top left: what it showed (four questions, the prompt left out); top right: four questions
// and a prompt; below: a prompt alone. Screenshots go to app/screenshots/widgets/.
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h892dp-xxhdpi")
class NeedsYouWidgetTest {
    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-10-18T09:00:00Z")
    private val source = Source("devbox", "demo", "s")
    private fun question(n: Int) = Decision("q$n", "q$n", "", emptyList(), null, source, now.minusSeconds(60L * n))
    private val prompt = Prompt("p", "Bash", "git push", null, "{}", emptyList(), source, now.minusSeconds(30), now.plusSeconds(600))
    private val four = (1..4).map(::question)

    private class Sample(val content: @Composable () -> Unit) : GlanceAppWidget() {
        override val sizeMode = SizeMode.Exact
        override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { content() }
    }

    private fun widget(needs: NeedsYou) = Sample { NeedsYouWidget(needs, Palette.of(Colours.Starbridge)) }

    @OptIn(ExperimentalGlanceApi::class)
    @Test fun waitingPromptsCount() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val density = context.resources.displayMetrics.density
        fun px(dp: Float) = (dp * density).toInt()
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(20f), px(20f), px(20f), px(20f))
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFFCFE0EA.toInt(), 0xFFE8D9E6.toInt(), 0xFFDCE6D5.toInt()))
        }
        val size = DpSize(172.dp, 172.dp)
        runBlocking {
            val rows = listOf(
                listOf(NeedsYou(4, 0), NeedsYou.of(four, listOf(prompt), now)),
                listOf(NeedsYou.of(emptyList(), listOf(prompt), now)),
            )
            rows.forEach { line ->
                val row = LinearLayout(context)
                root.addView(row, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = px(16f) })
                line.forEachIndexed { i, needs ->
                val frame = FrameLayout(context)
                row.addView(frame, LinearLayout.LayoutParams(px(size.width.value), px(size.height.value)).apply { if (i > 0) leftMargin = px(12f) })
                val view = widget(needs).compose(context, size = size).apply(context, frame)
                view.clipToOutline = true
                frame.addView(view, FrameLayout.LayoutParams(-1, -1))
                }
            }
        }
        compose.setContent { AndroidView(factory = { root }, modifier = Modifier.fillMaxWidth()) }
        compose.onRoot().captureRoboImage("screenshots/widgets/needs-you-prompts.png")
    }
}
