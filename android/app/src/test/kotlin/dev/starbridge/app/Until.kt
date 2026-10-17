package dev.starbridge.app

/**
 * Waits until [condition] holds, for work the test does not drive itself: the store's IO
 * coroutines, a MockWebServer's reply. Fails with [what] after 10 s.
 */
fun until(what: String = "timed out", condition: () -> Boolean) {
    val end = System.currentTimeMillis() + 10_000
    while (!condition()) {
        check(System.currentTimeMillis() < end) { what }
        Thread.sleep(10)
    }
}
