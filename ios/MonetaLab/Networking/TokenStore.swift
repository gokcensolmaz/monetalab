import Foundation
import Security

/// Persists the opaque session token so the user stays signed in across launches (local QA fixture).
protocol TokenStore: AnyObject {
    func load() -> String?
    func save(_ token: String)
    func clear()
}

/// Stores the token in the Keychain (this-device-only, available after first unlock). Never in UserDefaults or logs.
final class KeychainTokenStore: TokenStore {
    private let service = "dev.monetalab.qa.session"
    private let account = "bearer-token"

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ token: String) {
        clear()
        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

final class InMemoryTokenStore: TokenStore {
    private var token: String?
    init(token: String? = nil) { self.token = token }
    func load() -> String? { token }
    func save(_ token: String) { self.token = token }
    func clear() { token = nil }
}
