package dev.starbridge.app.di

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.goterl.lazysodium.LazySodiumAndroid
import com.goterl.lazysodium.SodiumAndroid
import com.google.firebase.FirebaseApp
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import dev.starbridge.app.BuildConfig
import dev.starbridge.app.data.Alerts
import dev.starbridge.app.data.Disk
import dev.starbridge.app.data.KeystoreVault
import dev.starbridge.app.data.ServerStore
import dev.starbridge.app.data.Store
import dev.starbridge.app.protocol.Directories
import dev.starbridge.app.protocol.Envelopes
import dev.starbridge.app.protocol.Pairings
import dev.starbridge.app.protocol.Sodium
import dev.starbridge.app.push.Notifier
import dev.starbridge.app.push.Pusher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton
    fun scope(): CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Provides @Singleton
    fun http(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @Provides @Singleton
    fun sodium(): Sodium = Sodium(LazySodiumAndroid(SodiumAndroid()))

    @Provides @Singleton
    fun notifier(@ApplicationContext context: Context): Notifier = Notifier(context)

    @Provides @Singleton
    fun store(@ApplicationContext context: Context, http: OkHttpClient, sodium: Sodium, notifier: Notifier, scope: CoroutineScope): ServerStore {
        val envelopes = Envelopes(sodium)
        val name = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) ?: Build.MODEL
        return ServerStore(
            disk = Disk(File(context.noBackupFilesDir, "starbridge"), KeystoreVault()),
            http = http,
            sodium = sodium,
            envelopes = envelopes,
            directories = Directories(sodium, envelopes),
            pairings = Pairings(sodium),
            alerts = notifier,
            deviceName = name,
            defaultServer = BuildConfig.DEFAULT_SERVER,
            fcmAvailable = FirebaseApp.getApps(context).isNotEmpty(),
            scope = scope,
        )
    }

    @Provides @Singleton
    fun pusher(@ApplicationContext context: Context, store: ServerStore, scope: CoroutineScope) = Pusher(context, store, scope)
}

@Module
@InstallIn(SingletonComponent::class)
abstract class BindModule {
    @Binds abstract fun store(store: ServerStore): Store
    @Binds abstract fun alerts(notifier: Notifier): Alerts
}

/** For the receiver and services, which Hilt does not inject. */
@EntryPoint
@InstallIn(SingletonComponent::class)
interface AppEntry {
    fun store(): ServerStore
    fun notifier(): Notifier
    fun scope(): CoroutineScope
}

fun Context.app(): AppEntry = EntryPointAccessors.fromApplication(applicationContext, AppEntry::class.java)
