// A caching mirror of Google's Maven, Maven Central and the Gradle Plugin Portal, set per machine
// as `starbridge.mavenMirror=http://host:port` in ~/.gradle/gradle.properties: the home one serves
// the dev box and the self-hosted runners that reach it, and keeps Maven Central's rate limit off
// them (docs/ci.md). It is plain HTTP on the LAN. The public repositories stay after it, for
// anything it lacks and for every machine without the property.
pluginManagement {
    val mirror = providers.gradleProperty("starbridge.mavenMirror").orNull?.trimEnd('/')
    repositories {
        if (mirror != null) {
            for (path in listOf("google", "maven-central", "gradle-plugins")) maven {
                url = uri("$mirror/$path/")
                isAllowInsecureProtocol = true
            }
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    val mirror = providers.gradleProperty("starbridge.mavenMirror").orNull?.trimEnd('/')
    repositories {
        if (mirror != null) {
            for (path in listOf("google", "maven-central")) maven {
                url = uri("$mirror/$path/")
                isAllowInsecureProtocol = true
            }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "starbridge"
include(":app")
