// Fixed releases of what AGP's own classpath pulls in (osv-scanner, #2068): AGP 9.4.1 asks for
// older ones. Build-time only; none of these ships in the APK. Drop a line when AGP asks for the
// fixed release itself.
buildscript {
    dependencies {
        constraints {
            for (pin in listOf(
                "org.apache.commons:commons-lang3:3.21.0",
                "org.bitbucket.b_c:jose4j:0.9.7",
                "org.bouncycastle:bcpkix-jdk18on:1.86",
                "org.bouncycastle:bcprov-jdk18on:1.86",
                "org.jdom:jdom2:2.0.6.1",
            )) add("classpath", pin)
        }
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.roborazzi) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}
