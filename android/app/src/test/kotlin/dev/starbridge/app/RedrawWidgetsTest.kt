package dev.starbridge.app

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.widget.QuestionsWidget
import dev.starbridge.app.widget.QuestionsWidgetReceiver
import dev.starbridge.app.widget.QuotasWidget
import dev.starbridge.app.widget.QuotasWidgetReceiver
import dev.starbridge.app.widget.redrawWidgets
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Each placed widget redraws with its own receiver's widget (#1930). Release builds merge the two
 * widget classes into one, so finding a widget by its class's name, as Glance's `updateAll` does,
 * drew Needs you into a Quotas widget.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RedrawWidgetsTest {
    @Test fun eachWidgetRedrawsAsItsOwnKind() = runTest {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val manager = shadowOf(AppWidgetManager.getInstance(context))
        manager.bindAppWidgetId(1, ComponentName(context, QuotasWidgetReceiver::class.java))
        manager.bindAppWidgetId(2, ComponentName(context, QuestionsWidgetReceiver::class.java))
        manager.bindAppWidgetId(3, ComponentName(context, QuotasWidgetReceiver::class.java))
        val drawn = mutableMapOf<Int, String>()
        redrawWidgets(context) { widget, id -> drawn[id] = widget::class.simpleName!! }
        assertEquals(
            mapOf(1 to QuotasWidget::class.simpleName, 2 to QuestionsWidget::class.simpleName, 3 to QuotasWidget::class.simpleName),
            drawn,
        )
    }
}
