import Foundation
import Security

/** What only this iPhone may know: the session and its private keys. */
struct Secrets: Codable, Equatable {
    var session: String?
    /** The PKCE verifier of the sign-in in progress. */
    var signInVerifier: String?
    var boxPk: String?
    var boxSk: String?
    var signPk: String?
    var signSk: String?
    /** The claim secret of a join by code, which fetches its result. */
    var claim: String?
    /** The ephemeral key pair of a join by digits. */
    var joinPk: String?
    var joinSk: String?
    /** The recovery key's seed, from the first device's setup until the owner confirms they stored it. */
    var recoverySeed: String?
}

/** Stores [Secrets] somewhere only this app reads. */
protocol Vault {
    func load() throws -> Secrets
    func save(_ secrets: Secrets) throws
    /** Keeps the secrets under `tag` and empties the item: they go with a saved state set aside. */
    func setAside(_ tag: String) throws
}

struct VaultError: Error, CustomStringConvertible {
    let status: OSStatus
    var description: String { "keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)")" }
}

/**
 * The secrets as one keychain item, readable after the first unlock since boot and never moved
 * to another device by a backup, so a notification can answer from the lock screen as on Android.
 * The item lives in the app group, which doubles as a keychain access group, so the notification
 * service extension opens the boxes with the same keys.
 */
struct KeychainVault: Vault {
    var service = "dev.starbridge.ios"
    var account = "secrets"
    var group: String? = APP_GROUP

    private var query: [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    func load() throws -> Secrets {
        let secrets = try read(query)
        if secrets == Secrets(), group != nil { return try moveIntoGroup() }
        return secrets
    }

    /**
     * Builds before the app group kept the item in the app's own access group: moves it into
     * the group once, so an update keeps its keys.
     */
    private func moveIntoGroup() throws -> Secrets {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let old = (out as? [String: Any])?[kSecAttrAccessGroup as String] as? String, old != group else { return Secrets() }
        var legacy = q
        legacy.removeValue(forKey: kSecReturnAttributes as String)
        legacy.removeValue(forKey: kSecMatchLimit as String)
        legacy[kSecAttrAccessGroup as String] = old
        let secrets = try read(legacy)
        try save(secrets)
        SecItemDelete(legacy as CFDictionary)
        return secrets
    }

    private func read(_ query: [String: Any]) throws -> Secrets {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return Secrets() }
        guard status == errSecSuccess, let data = out as? Data else { throw VaultError(status: status) }
        return try JSONDecoder().decode(Secrets.self, from: data)
    }

    func save(_ secrets: Secrets) throws {
        if secrets == Secrets() {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError(status: status) }
            return
        }
        let data = try JSONEncoder().encode(secrets)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw VaultError(status: status) }
    }

    func setAside(_ tag: String) throws {
        let secrets = try load()
        guard secrets != Secrets() else { return }
        try KeychainVault(service: service, account: "\(account).unreadable-\(tag)", group: group).save(secrets)
        try save(Secrets())
    }
}
