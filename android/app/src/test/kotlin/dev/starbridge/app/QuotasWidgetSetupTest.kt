package dev.starbridge.app

import android.appwidget.AppWidgetManager
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import dev.starbridge.app.widget.QuotasWidgetSetup
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A widget that is gone when its setup opens ends the setup; it must not crash the app (internal audit 2026-10-14). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class QuotasWidgetSetupTest {
    @Test fun aWidgetIdWithNoWidgetFinishesTheSetup() {
        val intent = Intent(ApplicationProvider.getApplicationContext(), QuotasWidgetSetup::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 4242)
        val controller = Robolectric.buildActivity(QuotasWidgetSetup::class.java, intent).create()
        shadowOf(android.os.Looper.getMainLooper()).idle()
        Thread.sleep(500)
        shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue(controller.get().isFinishing)
    }
}
