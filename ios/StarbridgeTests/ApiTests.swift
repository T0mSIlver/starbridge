import XCTest
@testable import Starbridge

/** Answers each request with the next scripted status and headers, then 200 `{"account":"a_1"}`. */
final class Scripted: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var replies: [(Int, [String: String])] = []
    nonisolated(unsafe) static var requests = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Scripted.requests += 1
        let (status, headers) = Scripted.replies.isEmpty ? (200, [:]) : Scripted.replies.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((status == 200 ? #"{"account":"a_1"}"# : #"{"error":"busy"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/** Restarts go unnoticed and a rate limit holds every call (spec/clients.md, #250, #645, #1160). */
final class ApiTests: XCTestCase {
    private var api: Api!

    override func setUp() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Scripted.self]
        api = Api(server: "https://example.test", session: "sb_1", http: URLSession(configuration: config))
        Scripted.replies = []
        Scripted.requests = 0
        Api.limitedUntil.withLock { $0 = .distantPast }
    }

    override func tearDown() { Api.limitedUntil.withLock { $0 = .distantPast } }

    func testA503IsRetriedQuietly() async throws {
        Scripted.replies = [(503, [:]), (502, [:])]
        let me = try await api.me()
        XCTAssertEqual(me.account, "a_1")
        XCTAssertEqual(Scripted.requests, 3)
    }

    func testRetryAfterHoldsTheNextCallsToo() async throws {
        Scripted.replies = [(429, ["Retry-After": "1"])]
        let started = Date()
        _ = try await api.me()
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(Scripted.requests, 2)

        // A hold past the retry window reaches the caller without a request.
        Scripted.replies = [(429, ["Retry-After": "60"])]
        await XCTAssertThrowsAsync(try await api.me()) { XCTAssertEqual(($0 as? ApiError)?.error, "rate-limited") }
        await XCTAssertThrowsAsync(try await api.me()) { XCTAssertEqual(($0 as? ApiError)?.error, "rate-limited") }
        XCTAssertEqual(Scripted.requests, 3)
    }

    func testA429WithoutRetryAfterIsACapAndReachesTheCallerAtOnce() async throws {
        Scripted.replies = [(429, [:])]
        await XCTAssertThrowsAsync(try await api.me()) { XCTAssertEqual(($0 as? ApiError)?.status, 429) }
        XCTAssertEqual(Scripted.requests, 1)
    }

    func testRetryAfterReadsSecondsOrADate() {
        XCTAssertEqual(Api.retryAfter("30"), 30)
        XCTAssertEqual(Api.retryAfter("Wed, 21 Oct 2015 07:28:00 GMT"), 0)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let soon = try? XCTUnwrap(Api.retryAfter(f.string(from: Date().addingTimeInterval(120))))
        XCTAssertEqual(soon ?? 0, 120, accuracy: 2)
        XCTAssertEqual(Api.retryAfter("Wednesday, 21-Oct-15 07:28:00 GMT"), 0)
        XCTAssertEqual(Api.retryAfter("Wed Oct 21 07:28:00 2015"), 0)
        f.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        XCTAssertEqual(Api.retryAfter(f.string(from: Date().addingTimeInterval(120))) ?? 0, 120, accuracy: 2)
        XCTAssertNil(Api.retryAfter("soon"))
        XCTAssertNil(Api.retryAfter("inf"))
        XCTAssertNil(Api.retryAfter("-5"))
    }
}

func XCTAssertThrowsAsync<T>(_ body: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line, _ check: (Error) -> Void = { _ in }) async {
    do {
        _ = try await body()
        XCTFail("did not throw", file: file, line: line)
    } catch {
        check(error)
    }
}
