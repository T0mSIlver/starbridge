// Code the build scripts share. VersionCode.kt is plain Kotlin, so the app's unit tests compile it
// too (app/build.gradle.kts adds it to the test sources).
plugins {
    `kotlin-dsl`
}

repositories {
    mavenCentral()
}
