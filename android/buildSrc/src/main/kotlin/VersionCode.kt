/**
 * Above every code Play and phones have seen: 1.0.0-rc.1 (1000001) went to Play's closed test
 * before the first public release became 0.1.0, and Play refuses a lower code, as phones refuse a
 * downgrade (#551).
 */
const val VERSION_CODE_BASE = 2_000_000

/**
 * The Android versionCode of a release: 0.1.0 → 2_010_099, 1.2.3 → 3_020_399, and 1.2.3-rc.4 →
 * 3_020_304, so release candidates sort before the release. rcs take slots 1 to 49 and main's
 * builds 50 to 98 (mainVersionCodeOf), so the owner's phone takes main over an rc and the final
 * over both (#1540).
 */
fun versionCodeOf(name: String): Int {
    val m = Regex("""(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?""").matchEntire(name)
        ?: error("versionName must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got $name")
    val (major, minor, patch, rc) = m.destructured
    require(minor.toInt() < 100 && patch.toInt() < 100 && (rc.isEmpty() || rc.toInt() in 1..49)) { "versionName out of range: $name" }
    return VERSION_CODE_BASE + major.toInt() * 1_000_000 + minor.toInt() * 10_000 + patch.toInt() * 100 + (if (rc.isEmpty()) 99 else rc.toInt())
}

/**
 * The versionCode of a build of main for Play's internal track (#1540): slots 50 to 98 of the
 * version under way, which is [name] for an rc and the next patch for a final. [after] is the
 * highest code the track already holds: the build takes the next slot, so each build is above the
 * last, and fails once the version's 49 slots are spent, as an rc would then be due anyway.
 */
fun mainVersionCodeOf(name: String, after: Int): Int {
    val m = Regex("""(\d+)\.(\d+)\.(\d+)(-rc\.\d+)?""").matchEntire(name)
        ?: error("versionName must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-rc.N, got $name")
    val (major, minor, patch, rc) = m.destructured
    val underWay = if (rc.isEmpty()) "$major.$minor.${patch.toInt() + 1}" else "$major.$minor.$patch"
    val first = versionCodeOf("$underWay-rc.1") - 1 + 50
    val code = maxOf(first, after + 1)
    require(code <= first + 48) { "no build of main left for $underWay: slots 50 to 98 are spent" }
    return code
}
