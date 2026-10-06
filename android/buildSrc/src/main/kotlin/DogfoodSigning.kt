import java.io.File
import java.util.Properties

/** The release key as the maintainer keeps it: the keystore, the file holding its password, and the alias. */
class DogfoodKey(val store: File, val passwordFile: File, val alias: String)

/**
 * The release key for the maintainer's local debug builds (#569), so a dogfood APK verifies for
 * starbridge.run's App Links, whose assetlinks.json lists only the release key. Only when
 * android/local.properties, which git ignores, says `starbridge.dogfoodSigning=true`, and never
 * where CI is set, as on every GitHub Actions runner, so no pull request job can turn it on.
 */
fun dogfoodKey(localProperties: Properties, env: Map<String, String>, home: File): DogfoodKey? {
    if (localProperties.getProperty("starbridge.dogfoodSigning")?.trim() != "true") return null
    check(env["CI"].isNullOrEmpty()) { "starbridge.dogfoodSigning is for local builds, and CI is set" }
    val dir = File(home, ".config/starbridge/secrets")
    return DogfoodKey(File(dir, "release.jks"), File(dir, "release-keystore-password"), "starbridge")
}
