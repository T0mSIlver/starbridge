/**
 * Above every code Play and phones have seen: 1.0.0-rc.1 (1000001) went to Play's closed test
 * before the first public release became 0.1.0, and Play refuses a lower code, as phones refuse a
 * downgrade (#551).
 */
const val VERSION_CODE_BASE = 2_000_000

/**
 * The Android versionCode of a release: 0.1.0 → 2_010_099, 1.2.3 → 3_020_399, and 1.2.3-rc.4 →
 * 3_020_304, so release candidates sort before the release.
 */
fun versionCodeOf(name: String): Int {
    val m = Regex("""(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?""").matchEntire(name)
        ?: error("versionName must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got $name")
    val (major, minor, patch, rc) = m.destructured
    require(minor.toInt() < 100 && patch.toInt() < 100 && (rc.isEmpty() || rc.toInt() in 1..98)) { "versionName out of range: $name" }
    return VERSION_CODE_BASE + major.toInt() * 1_000_000 + minor.toInt() * 10_000 + patch.toInt() * 100 + (if (rc.isEmpty()) 99 else rc.toInt())
}
