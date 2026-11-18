import Foundation

/// Authentication state and the signed-in session (AUTH-01).
@MainActor
final class AppModel: ObservableObject {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(User)
    }

    @Published private(set) var state: State = .restoring
    @Published var authError: String?
    @Published private(set) var isWorking = false

    let api: MonetaLabAPI
    private let tokenStore: TokenStore
    private(set) var token: String?

    init(api: MonetaLabAPI, tokenStore: TokenStore) {
        self.api = api
        self.tokenStore = tokenStore
    }

    var user: User? {
        if case let .signedIn(user) = state { return user }
        return nil
    }

    /// Restores a stored session. Invalid, expired or revoked tokens are discarded.
    func restore() async {
        guard let stored = tokenStore.load() else { state = .signedOut; return }
        do {
            let user = try await api.me(token: stored)
            token = stored
            state = .signedIn(user)
        } catch APIError.unauthenticated {
            tokenStore.clear()
            state = .signedOut
        } catch {
            // Server unreachable: keep the token for a later retry, but show the sign-in screen with a clear message.
            authError = (error as? APIError)?.userMessage ?? error.localizedDescription
            state = .signedOut
        }
    }

    func signIn(email: String, password: String) async {
        await perform {
            let response = try await self.api.login(email: email, password: password)
            self.tokenStore.save(response.token)
            self.token = response.token
            self.state = .signedIn(response.user)
        }
    }

    /// Creates the account, then signs in. The server doesn't log in automatically on register (D-S3-02).
    func register(email: String, password: String) async {
        await perform {
            _ = try await self.api.register(email: email, password: password)
            let response = try await self.api.login(email: email, password: password)
            self.tokenStore.save(response.token)
            self.token = response.token
            self.state = .signedIn(response.user)
        }
    }

    func signOut() async {
        if let token { try? await api.logout(token: token) } // revoke server-side, then clear locally regardless
        endSession()
    }

    /// Called whenever any request returns 401.
    func endSession(message: String? = nil) {
        tokenStore.clear()
        token = nil
        authError = message
        state = .signedOut
    }

    private func perform(_ work: @escaping () async throws -> Void) async {
        isWorking = true
        authError = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch let error as APIError {
            switch error {
            case .unauthenticated: authError = "Email or password is incorrect."
            default: authError = error.userMessage
            }
        } catch {
            authError = error.localizedDescription
        }
    }
}
