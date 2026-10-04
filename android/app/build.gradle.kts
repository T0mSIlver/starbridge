import groovy.json.JsonSlurper

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.roborazzi)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "dev.starbridge.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.starbridge.app"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // The hosted server; self-hosters change it on the sign-in screen.
        buildConfigField("String", "DEFAULT_SERVER", "\"https://starbridge.run\"")
        firebaseResources()
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // No release key yet: release installs on the debug key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
        resValues = true
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric's SDK 36 sandbox reaches into java.base internals.
        unitTests.all {
            it.jvmArgs("--add-exports=java.base/jdk.internal.access=ALL-UNNAMED", "--add-opens=java.base/java.io=ALL-UNNAMED")
            // The protocol's test vectors, at the repo root (packages/protocol, #1).
            it.systemProperty("starbridge.vectors", rootProject.file("../packages/protocol/vectors").absolutePath)
        }
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons)
    implementation(libs.activity.compose)
    implementation(libs.core.splashscreen)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.hilt.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.serialization.json)
    implementation(libs.navigation3.runtime)
    implementation(libs.navigation3.ui)
    implementation(libs.adaptive.layout)
    implementation(libs.adaptive.navigation3)
    implementation(libs.navigation.suite)
    implementation(libs.okhttp)
    implementation(libs.browser)
    implementation(libs.firebase.messaging)
    implementation(libs.unifiedpush)
    // Scanning needs no camera permission: Google's scanner runs in Play services.
    implementation(libs.code.scanner)
    implementation(libs.zxing.core)
    implementation(libs.lifecycle.viewmodel.navigation3)
    // Lazysodium loads libsodium through JNA; Android needs JNA's AAR, which carries
    // its native dispatch library per ABI.
    implementation(libs.lazysodium.android) { exclude(group = "net.java.dev.jna") }
    implementation("${libs.jna.get()}@aar")
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
    // Unit tests run on the JVM: lazysodium-java bundles libsodium for desktop
    // platforms, and the JNA jar its dispatch library.
    testImplementation(libs.lazysodium.java)
    testImplementation(libs.jna)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coroutines.test)
}

/**
 * Firebase's values as string resources, which FirebaseInitProvider reads; what the
 * google-services plugin would generate. google-services.json stays out of git: it is read from
 * ~/.config/starbridge/secrets/, else from app/ (a placeholder there until the real one lands). Without it the app builds with FCM off and
 * offers UnifiedPush only.
 */
fun com.android.build.api.dsl.ApplicationDefaultConfig.firebaseResources() {
    val file = listOf(
        File(System.getProperty("user.home"), ".config/starbridge/secrets/google-services.json"),
        file("google-services.json"),
    ).firstOrNull { it.isFile } ?: return
    @Suppress("UNCHECKED_CAST")
    val json = JsonSlurper().parse(file) as Map<String, Any?>
    val project = json["project_info"] as Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    val client = (json["client"] as List<Map<String, Any?>>).first {
        ((it["client_info"] as Map<String, Any?>)["android_client_info"] as Map<String, Any?>)["package_name"] == "dev.starbridge.app"
    }
    @Suppress("UNCHECKED_CAST")
    val apiKey = (client["api_key"] as List<Map<String, Any?>>).first()["current_key"] as String
    resValue("string", "google_app_id", (client["client_info"] as Map<String, Any?>)["mobilesdk_app_id"] as String)
    resValue("string", "gcm_defaultSenderId", project["project_number"] as String)
    resValue("string", "project_id", project["project_id"] as String)
    resValue("string", "google_api_key", apiKey)
    (project["storage_bucket"] as String?)?.let { resValue("string", "google_storage_bucket", it) }
}
