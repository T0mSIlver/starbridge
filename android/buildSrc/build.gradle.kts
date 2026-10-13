// Code the build scripts share. VersionCode.kt is plain Kotlin, so the app's unit tests compile it
// too (app/build.gradle.kts adds it to the test sources).
plugins {
    `kotlin-dsl`
}

// The machine's Maven mirror first, when it has one (settings.gradle.kts).
val mirror = providers.gradleProperty("starbridge.mavenMirror").orNull?.trimEnd('/')
repositories {
    if (mirror != null) maven {
        url = uri("$mirror/maven-central/")
        isAllowInsecureProtocol = true
    }
    mavenCentral()
}
