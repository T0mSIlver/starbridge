// What zod checks in packages/protocol/src/schemas.ts, for the types in Schemas.swift. Every
// failure is `bad-schema`. Lengths count code points, as zod does; times follow
// zod's `iso.datetime({ offset: true })`.

func schema(_ ok: Bool, _ what: @autoclosure () -> String) throws {
    if !ok { throw ProtocolError(.badSchema, what()) }
}

private func isB64Char(_ c: UInt8) -> Bool {
    (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) || c == 0x2D || c == 0x5F
}

/** `B64`: base64url without padding, at least one character. */
func checkB64(_ s: String, _ what: String) throws {
    try schema(!s.utf8.isEmpty && s.utf8.allSatisfy(isB64Char), what)
}

/** `Bytes32` (43 characters: a public key, a BLAKE2b-256 hash, a MAC) or `Bytes64` (86: a signature), #1283. */
func checkBytes(_ s: String, _ chars: Int, _ what: String) throws {
    try schema(s.utf8.count == chars && s.utf8.allSatisfy(isB64Char), what)
}

/** `Id`: 1 to 64 base64url characters. */
func checkId(_ s: String, _ what: String) throws {
    try schema((1...64).contains(s.utf8.count) && s.utf8.allSatisfy(isB64Char), what)
}

/** A string's length as zod counts it: in code points, not UTF-16 units. */
func codePoints(_ s: String) -> Int { s.unicodeScalars.count }

func checkLength(_ s: String, _ min: Int, _ max: Int, _ what: String) throws {
    try schema((min...max).contains(codePoints(s)), what)
}

func checkTime(_ s: String, _ what: String) throws {
    try schema(epochMillis(s) != nil, what)
}

/** A string zod's `iso.datetime({ offset: true })` accepts, as JavaScript's Date.parse reads it. */
func epochMillis(_ s: String) -> Int64? {
    let c = Array(s.utf8)
    var i = 0
    func digits(_ n: Int) -> Int? {
        guard i + n <= c.count else { return nil }
        var v = 0
        for k in i..<i + n {
            guard (0x30...0x39).contains(c[k]) else { return nil }
            v = v * 10 + Int(c[k] - 0x30)
        }
        i += n
        return v
    }
    func expect(_ ch: Character) -> Bool {
        guard i < c.count, c[i] == ch.asciiValue! else { return false }
        i += 1
        return true
    }
    guard let year = digits(4), expect("-"), let month = digits(2), expect("-"), let day = digits(2),
          expect("T"), let hour = digits(2), expect(":"), let minute = digits(2), expect(":"), let second = digits(2)
    else { return nil }
    guard (1...12).contains(month), day >= 1, day <= daysIn(month, year), hour < 24, minute < 60, second < 60 else { return nil }
    var millis = 0
    if i < c.count, c[i] == 0x2E {
        i += 1
        let start = i
        while i < c.count, (0x30...0x39).contains(c[i]) {
            // Date.parse keeps milliseconds and drops finer digits.
            if i - start < 3 { millis = millis * 10 + Int(c[i] - 0x30) }
            i += 1
        }
        guard i > start else { return nil }
        for _ in min(i - start, 3)..<3 { millis *= 10 }
    }
    var offset = 0
    guard i < c.count else { return nil }
    if c[i] == UInt8(ascii: "Z") {
        i += 1
    } else if c[i] == UInt8(ascii: "+") || c[i] == UInt8(ascii: "-") {
        let sign = c[i] == UInt8(ascii: "-") ? -1 : 1
        i += 1
        guard let oh = digits(2), expect(":"), let om = digits(2), oh < 24, om < 60 else { return nil }
        offset = sign * (oh * 60 + om)
    } else {
        return nil
    }
    guard i == c.count else { return nil }
    let days = daysFromCivil(year, month, day)
    let seconds = Int64(days) * 86400 + Int64(hour * 3600 + minute * 60 + second) - Int64(offset * 60)
    return seconds * 1000 + Int64(millis)
}

private func isLeap(_ y: Int) -> Bool { y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) }

private func daysIn(_ month: Int, _ year: Int) -> Int {
    switch month {
    case 2: isLeap(year) ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm). */
func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

/** "YYYY-MM-DDTHH:MM:SSZ" for whole seconds since the epoch, as `toISOString` cut to seconds. */
func isoSeconds(_ millis: Int64) -> String {
    let secs = millis >= 0 ? millis / 1000 : (millis - 999) / 1000
    let days = Int(secs >= 0 ? secs / 86400 : (secs - 86399) / 86400)
    let rem = Int(secs - Int64(days) * 86400)
    let z = days + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
    func pad(_ v: Int, _ n: Int) -> String {
        let s = String(v)
        return String(repeating: "0", count: max(0, n - s.count)) + s
    }
    return "\(pad(y, 4))-\(pad(m, 2))-\(pad(d, 2))T\(pad(rem / 3600, 2)):\(pad(rem / 60 % 60, 2)):\(pad(rem % 60, 2))Z"
}

/**
 * A JSON object's fields as zod reads them: a field `optional` in schemas.ts may be absent but
 * not null, a `nullable` one must be present and may be null, and keys the schema does not name
 * are dropped.
 */
struct Fields {
    let object: JSONObject
    let path: String

    init(_ value: JSON?, _ path: String) throws {
        guard let o = value?.object else { throw ProtocolError(.badSchema, "\(path): not an object") }
        object = o
        self.path = path
    }

    private func name(_ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }

    func value(_ key: String) throws -> JSON {
        guard let v = object[key] else { throw ProtocolError(.badSchema, "\(name(key)): missing") }
        return v
    }

    /** Nil when absent; a null is refused. */
    func optional(_ key: String) throws -> JSON? {
        guard let v = object[key] else { return nil }
        try schema(!v.isNull, "\(name(key)): null")
        return v
    }

    /** Must be present; nil for a null. */
    func nullable(_ key: String) throws -> JSON? {
        let v = try value(key)
        return v.isNull ? nil : v
    }

    func string(_ key: String) throws -> String {
        try asString(try value(key), name(key))
    }

    func optString(_ key: String) throws -> String? {
        try optional(key).map { try asString($0, name(key)) }
    }

    func int(_ key: String) throws -> Int {
        try asInt(try value(key), name(key))
    }

    func number(_ key: String) throws -> Double {
        // zod refuses Infinity, which JSON.parse makes of 1e309.
        guard let n = try value(key).number, n.isFinite else { throw ProtocolError(.badSchema, "\(name(key)): not a number") }
        return n
    }

    func bool(_ key: String) throws -> Bool {
        guard let b = try value(key).bool else { throw ProtocolError(.badSchema, "\(name(key)): not a boolean") }
        return b
    }

    /** `z.literal(true).optional()`. */
    func optTrue(_ key: String) throws -> Bool? {
        guard let v = try optional(key) else { return nil }
        try schema(v == .bool(true), "\(name(key)): true or absent")
        return true
    }

    func array(_ key: String) throws -> [JSON] {
        guard let a = try value(key).array else { throw ProtocolError(.badSchema, "\(name(key)): not an array") }
        return a
    }

    func optArray(_ key: String) throws -> [JSON]? {
        try optional(key).map { v in
            guard let a = v.array else { throw ProtocolError(.badSchema, "\(name(key)): not an array") }
            return a
        }
    }

    func strings(_ key: String) throws -> [String] {
        try array(key).map { try asString($0, name(key)) }
    }

    /** `v: z.literal(1)`. */
    func version() throws {
        try schema(try value("v") == .number(1), name("v"))
    }

    func id(_ key: String) throws -> String {
        let s = try string(key)
        try checkId(s, name(key))
        return s
    }

    func optId(_ key: String) throws -> String? {
        let s = try optString(key)
        if let s { try checkId(s, name(key)) }
        return s
    }

    func b64(_ key: String) throws -> String {
        let s = try string(key)
        try checkB64(s, name(key))
        return s
    }

    /** 32 bytes as base64url: `Bytes32`. */
    func bytes32(_ key: String) throws -> String {
        let s = try string(key)
        try checkBytes(s, 43, name(key))
        return s
    }

    /** 64 bytes as base64url: `Bytes64`. */
    func bytes64(_ key: String) throws -> String {
        let s = try string(key)
        try checkBytes(s, 86, name(key))
        return s
    }

    func time(_ key: String) throws -> String {
        let s = try string(key)
        try checkTime(s, name(key))
        return s
    }

    func optTime(_ key: String) throws -> String? {
        let s = try optString(key)
        if let s { try checkTime(s, name(key)) }
        return s
    }

    func text(_ key: String, _ min: Int, _ max: Int) throws -> String {
        let s = try string(key)
        try checkLength(s, min, max, name(key))
        return s
    }

    func optText(_ key: String, _ min: Int, _ max: Int) throws -> String? {
        let s = try optString(key)
        if let s { try checkLength(s, min, max, name(key)) }
        return s
    }

    func oneOf(_ key: String, _ allowed: Set<String>) throws -> String {
        let s = try string(key)
        try schema(allowed.contains(s), name(key))
        return s
    }

    /** `to: z.array(Id).min(1)`. */
    func recipients(_ key: String = "to") throws -> [String] {
        let ids = try strings(key)
        try schema(!ids.isEmpty, "\(name(key)): empty")
        for id in ids { try checkId(id, name(key)) }
        return ids
    }

    func child(_ key: String) throws -> Fields { try Fields(try value(key), name(key)) }
}

func asString(_ v: JSON, _ what: String) throws -> String {
    guard let s = v.string else { throw ProtocolError(.badSchema, "\(what): not a string") }
    return s
}

/** `z.number().int()`: a safe integer. */
func asInt(_ v: JSON, _ what: String) throws -> Int {
    guard let n = v.number, n == n.rounded(), abs(n) <= 9_007_199_254_740_991 else {
        throw ProtocolError(.badSchema, "\(what): not an integer")
    }
    return Int(n)
}

extension JSONObject {
    /** Sets `key` when `value` is not nil, for optional fields. */
    mutating func put(_ key: String, _ value: JSON?) {
        if let value { self[key] = value }
    }
}

extension JSON {
    init(_ s: String) { self = .string(s) }
    init(_ n: Int) { self = .number(Double(n)) }
    init(_ strings: [String]) { self = .array(strings.map(JSON.string)) }
}
