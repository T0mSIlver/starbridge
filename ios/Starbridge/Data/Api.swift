import Foundation
import os
import StarbridgeProtocol

/** A response the server refused: its status and `{error, detail}` (PROTOCOL.md, "Server API"). */
struct ApiError: Error, CustomStringConvertible {
    let status: Int
    let error: String?
    let detail: String?
    /** For 426 `client-too-old`: the oldest release the server serves. */
    var minimum: String?
    /** For 429: how long its `Retry-After` asks to wait. */
    var retryAfter: TimeInterval?

    var description: String { [error ?? "HTTP \(status)", detail].compactMap(\.self).joined(separator: ": ") }
}

struct Me: Equatable {
    let account: String
    let member: String?
}

/** A join by digits as the server holds it (PROTOCOL.md, "Joins"). */
struct JoinView {
    let state: String
    let version: Int
    let approverKey: String?
    let joinerKey: String?
    let approval: JSON?
}

/** An open join as `GET /joins` lists it (PROTOCOL.md, "Joins"). */
struct ListedJoin: Equatable {
    let id: String
    let request: String
    let commitment: String
    let approver: String?
    let expiresAt: Date?
}

/** One item of a list: the sealed item, where the list stands after it, and when it was answered. */
struct Listed {
    let item: SealedItem
    let receivedAt: String?
    let answeredAt: String?
}

struct ItemsPage {
    let items: [Listed]
    let cursor: String
}

/** The server's /v1 routes this app calls so far. */
struct Api {
    let server: String
    let session: String?
    var http: URLSession = .shared

    /** This release, as the server counts it and checks it against its minimum (PROTOCOL.md, "HTTP API"). */
    static let client = "ios/" + (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0")

    /**
     * A deploy restarts the server in a few seconds (#150), so a 502 or 503, or a refused
     * connection, is retried quietly for this long before the caller hears of it (#250).
     */
    static let retryFor: TimeInterval = 20

    /**
     * Until when a 429 with `Retry-After` holds every call of this app, a call's first try
     * included: the server is up and said when to come back (#645). Such a call is retried
     * whatever its method, since the request was refused before it did anything.
     */
    static let limitedUntil = OSAllocatedUnfairLock(initialState: Date.distantPast)

    private func call(_ method: String, _ path: String, _ body: JSON? = nil, headers: [String: String] = [:], wait: Int? = nil, ownLimit: Bool = false) async throws -> (Int, JSON?) {
        let started = Date()
        var pause: TimeInterval = 0.25
        while true {
            let limited = Api.limitedUntil.withLock { $0 }.timeIntervalSinceNow
            if !ownLimit && limited > 0 {
                if Date().timeIntervalSince(started) + limited > Api.retryFor {
                    throw ApiError(status: 429, error: "rate-limited", detail: "too many requests; retry later")
                }
                try await Task.sleep(for: .seconds(limited))
                continue
            }
            do {
                return try await once(method, path, body, headers: headers, wait: wait)
            } catch let e as ApiError where e.status == 429 && e.retryAfter != nil {
                if ownLimit { throw e }
                // Jitter spreads this app's calls past the limit's window, not into its first moment.
                let until = Date().addingTimeInterval(e.retryAfter! * Double.random(in: 1...1.25))
                Api.limitedUntil.withLock { $0 = max($0, until) }
                continue
            } catch {
                let transient = switch error {
                case let e as ApiError: e.status == 502 || e.status == 503
                // Refused: the request never left.
                case let e as URLError where e.code == .cannotConnectToHost: true
                // No network at all is not a restart: the caller says so at once.
                case let e as URLError where [.notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .cancelled].contains(e.code): false
                // Any other failure may have reached the server, so only a read, safe to repeat, retries.
                case is URLError: method == "GET"
                default: false
                }
                if !transient || Date().timeIntervalSince(started) + pause > Api.retryFor { throw error }
            }
            try await Task.sleep(for: .seconds(pause))
            pause = min(pause * 2, 4)
        }
    }

    private func once(_ method: String, _ path: String, _ body: JSON?, headers: [String: String], wait: Int?) async throws -> (Int, JSON?) {
        guard let url = URL(string: server + "/v1" + path) else { throw ApiError(status: 0, error: "bad-server", detail: server) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        // A long-poll holds up to `wait` seconds before it answers.
        request.timeoutInterval = TimeInterval((wait ?? 0) + 30)
        if let session { request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization") }
        request.setValue(Api.client, forHTTPHeaderField: "starbridge-client")
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(body.text.utf8)
        }
        let (data, response) = try await http.data(for: request)
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        let json = data.isEmpty ? nil : try? JSON.parse(String(decoding: data, as: UTF8.self))
        guard (200..<300).contains(status) else {
            let retryAfter = status == 429 ? http?.value(forHTTPHeaderField: "Retry-After").flatMap(Api.retryAfter) : nil
            throw ApiError(status: status, error: json?["error"]?.string, detail: json?["detail"]?.string, minimum: json?["minimum"]?.string, retryAfter: retryAfter)
        }
        return (status, json)
    }

    /** `Retry-After` in seconds, from seconds or an HTTP date in any of its three forms; nil when unreadable. */
    static func retryAfter(_ value: String) -> TimeInterval? {
        let v = value.trimmingCharacters(in: .whitespaces)
        if let seconds = TimeInterval(v) { return seconds.isFinite && seconds >= 0 ? seconds : nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        // IMF-fixdate, then the obsolete RFC 850 and asctime forms (RFC 9110, section 5.6.7).
        for format in ["EEE, dd MMM yyyy HH:mm:ss zzz", "EEEE, dd-MMM-yy HH:mm:ss zzz", "EEE MMM d HH:mm:ss yyyy"] {
            f.dateFormat = format
            if let date = f.date(from: v) { return max(0, date.timeIntervalSinceNow) }
        }
        return nil
    }

    private func field(_ json: JSON?, _ key: String) throws -> JSON {
        guard let value = json?[key] else { throw ProtocolError(.badSchema, "a reply without \(key)") }
        return value
    }

    private func string(_ json: JSON?, _ key: String) throws -> String {
        guard let s = try field(json, key).string else { throw ProtocolError(.badSchema, "\(key) is not a string") }
        return s
    }

    // --- Auth ------------------------------------------------------------------

    func appSession(code: String, verifier: String) async throws -> String {
        try string(await call("POST", "/auth/app/session", ["code": .string(code), "verifier": .string(verifier)]).1, "session")
    }

    func ownerSignIn(token: String) async throws -> String {
        try string(await call("POST", "/auth/owner", ["token": .string(token)]).1, "session")
    }

    func me() async throws -> Me {
        let body = try await call("GET", "/me").1
        return Me(account: try string(body, "account"), member: body?["member"]?.string)
    }

    /** A single-use nonce to sign for [bind]. */
    func challenge() async throws -> String { try string(await call("GET", "/auth/challenge").1, "nonce") }

    /** Binds this session to an existing device that signed the challenge with its key. */
    func bind(member: String, sig: String) async throws {
        _ = try await call("POST", "/auth/bind", ["member": .string(member), "sig": .string(sig)])
    }

    func logout() async throws { _ = try await call("POST", "/auth/logout") }

    /** Deletes the caller's account and everything the server holds for it (#1104). */
    func deleteAccount() async throws { _ = try await call("DELETE", "/account") }

    // --- Directory -------------------------------------------------------------

    func directory(from: Int) async throws -> [JSON] {
        guard let entries = try field(await call("GET", "/directory?from=\(from)").1, "entries").array else {
            throw ProtocolError(.badSchema, "entries is not a list")
        }
        return entries
    }

    func append(_ entry: JSON) async throws { _ = try await call("POST", "/directory", ["entry": entry]) }

    // --- Joining by code -------------------------------------------------------

    func postPairing(_ request: PairingMessage, claimHash: String) async throws {
        _ = try await call("POST", "/pairings", ["request": request.json, "claimHash": .string(claimHash)])
    }

    /** The approval once a device approved this one; nil when `wait` seconds pass first. */
    func pairingResult(rendezvous: String, claim: String, wait: Int) async throws -> JSON? {
        let (status, body) = try await call("GET", "/pairings/\(rendezvous)/result?wait=\(wait)", headers: ["X-Claim": claim], wait: wait)
        if status == 204 { return nil }
        // A reply without one is the server's fault, never the end of the app (#274).
        return try field(body, "approval")
    }

    // --- Adding a member ---------------------------------------------------------

    /** The request posted under a code's rendezvous id. */
    func pairing(_ rendezvous: String) async throws -> JSON { try field(await call("GET", "/pairings/\(rendezvous)").1, "request") }

    /** The request once a new member posts it under a code this iPhone shows; nil when `wait` seconds pass first. */
    func awaitPairing(_ rendezvous: String, wait: Int) async throws -> JSON? {
        let (status, body) = try await call("GET", "/pairings/\(rendezvous)?wait=\(wait)", wait: wait)
        return status == 204 ? nil : try field(body, "request")
    }

    func approvePairing(_ rendezvous: String, approval: PairingMessage) async throws {
        _ = try await call("POST", "/pairings/\(rendezvous)/approve", ["approval": approval.json])
    }

    // --- Joining by digits -----------------------------------------------------

    private func join(_ body: JSON?) throws -> JoinView {
        let j = try field(body, "join")
        guard let state = j["state"]?.string, let version = j["version"]?.number else {
            throw ProtocolError(.badSchema, "a join without its state")
        }
        return JoinView(state: state, version: Int(version), approverKey: j["approverKey"]?.string, joinerKey: j["joinerKey"]?.string, approval: j["approval"].flatMap { $0.isNull ? nil : $0 })
    }

    func postJoin(request: String, commitment: String) async throws -> JoinView {
        try join(await call("POST", "/joins", ["request": .string(request), "commitment": .string(commitment)]).1)
    }

    /** The join; with `wait`, holds until its version passes `after`. */
    func join(id: String, after: Int, wait: Int) async throws -> JoinView {
        try join(await call("GET", "/joins/\(id)?after=\(after)&wait=\(wait)", wait: wait).1)
    }

    /** The open joins, holding until one changes past `after`; and where the list stands. */
    func joins(after: String, wait: Int) async throws -> ([ListedJoin], String) {
        let body = try await call("GET", "/joins?after=\(after)&wait=\(wait)", wait: wait).1
        guard let list = try field(body, "joins").array else { throw ProtocolError(.badSchema, "joins is not a list") }
        let joins = list.compactMap { j -> ListedJoin? in
            guard let id = j["id"]?.string, let request = j["request"]?.string, let commitment = j["commitment"]?.string else { return nil }
            return ListedJoin(id: id, request: request, commitment: commitment, approver: j["approver"]?.string, expiresAt: j["expiresAt"]?.string.flatMap(Dates.parse))
        }
        return (joins, try string(body, "cursor"))
    }

    /** Posts this device's ephemeral key as the join's one approver. */
    func claimJoin(id: String, key: String, approver: String) async throws -> JoinView {
        try join(await call("POST", "/joins/\(id)/approver", ["key": .string(key), "approver": .string(approver)]).1)
    }

    func approveJoin(id: String, approval: PairingMessage) async throws {
        _ = try await call("POST", "/joins/\(id)/approve", ["approval": approval.json])
    }

    func revealJoin(id: String, key: String) async throws { _ = try await call("POST", "/joins/\(id)/reveal", ["key": .string(key)]) }

    func cancelJoin(id: String) async throws { _ = try await call("DELETE", "/joins/\(id)") }

    // --- Items -----------------------------------------------------------------

    private func listed(_ json: JSON) throws -> Listed {
        Listed(item: try SealedItem(json: try field(json, "item")), receivedAt: json["receivedAt"]?.string, answeredAt: json["answeredAt"]?.string)
    }

    /** A page of items of `kinds` after `cursor`, 100 at most (PROTOCOL.md, "Items"). */
    func items(_ kinds: String, after cursor: String) async throws -> ItemsPage {
        var q = URLComponents()
        q.queryItems = [URLQueryItem(name: "kind", value: kinds), URLQueryItem(name: "after", value: cursor)]
        let body = try await call("GET", "/items?" + (q.percentEncodedQuery ?? "")).1
        guard let list = try field(body, "items").array else { throw ProtocolError(.badSchema, "items is not a list") }
        // One item this app cannot read never hides the rest.
        return ItemsPage(items: list.compactMap { try? listed($0) }, cursor: try string(body, "cursor"))
    }

    func item(_ id: String) async throws -> Listed { try listed(try await call("GET", "/items/\(id)").1 ?? .null) }

    func postItem(_ item: JSON) async throws { _ = try await call("POST", "/items", item) }

    func deleteItem(_ id: String) async throws { _ = try await call("DELETE", "/items/\(id)") }

    /** The latest quota snapshot from each machine. */
    func quota() async throws -> [Listed] {
        guard let list = try field(try await call("GET", "/quota").1 ?? .null, "items").array else { throw ProtocolError(.badSchema, "items is not a list") }
        return list.compactMap { try? listed($0) }
    }

    /** Asks every machine for a fresh snapshot, holding until they posted one or `wait` seconds pass. */
    func askQuota(wait: Int) async throws { _ = try await call("POST", "/quota/ask?wait=\(wait)", wait: wait) }

    // --- Push ------------------------------------------------------------------

    /** Subscribes this iPhone's APNs token (hex) in its environment; re-subscribing a known one works. */
    func subscribe(apnsToken: String, environment: String) async throws -> String {
        try string(await call("POST", "/push/subscriptions", ["type": "apns", "endpoint": .string(apnsToken), "environment": .string(environment)]).1, "id")
    }

    func unsubscribe(_ id: String) async throws { _ = try await call("DELETE", "/push/subscriptions/\(id)") }

    /** Whether the owner sits at this iPhone ("Held pushes", #848). */
    func presence(_ present: Bool) async throws { _ = try await call("PUT", "/presence", ["present": .bool(present)], ownLimit: true) }

    /** The account's hold time in seconds (#848). */
    func pushHold() async throws -> Int {
        guard let n = try await call("GET", "/settings").1?["pushHold"]?.number else { throw ProtocolError(.badSchema, "settings without pushHold") }
        return Int(n)
    }

    /** Sets the hold time; returns it as the server reads it back. */
    func setPushHold(_ seconds: Int) async throws -> Int {
        guard let n = try await call("PUT", "/settings", ["pushHold": .number(Double(seconds))]).1?["pushHold"]?.number else { throw ProtocolError(.badSchema, "settings without pushHold") }
        return Int(n)
    }

    /** Whether this iPhone notifies, for every device's Devices list (#943). */
    func notificationState(_ state: String) async throws { _ = try await call("PUT", "/notifications", ["state": .string(state)]) }

    /** What each device last said of its notifications, and the app it said it from (#943, #1019), by member id. */
    func notifications() async throws -> (states: [String: String], clients: [String: String]) {
        let body = try await call("GET", "/notifications").1
        func strings(_ key: String) -> [String: String] {
            Dictionary((body?[key]?.object ?? JSONObject()).compactMap { k, v in v.string.map { (k, $0) } }, uniquingKeysWith: { $1 })
        }
        return (strings("devices"), strings("clients"))
    }

    /** The machines whose CLI is behind the latest release its agent read (#1050). */
    func machinesBehind() async throws -> Set<String> {
        let machines = try await call("GET", "/releases").1?["machines"]?.object ?? JSONObject()
        return Set(machines.filter { $0.1["behind"]?.bool == true }.map(\.0))
    }
}
