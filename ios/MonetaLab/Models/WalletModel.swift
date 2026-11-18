import Foundation

/// Wallet, credit history and purchase attempts, always loaded from the backend.
@MainActor
final class WalletModel: ObservableObject {
    @Published private(set) var wallet: Wallet?
    @Published private(set) var history: [HistoryEntry] = []
    @Published private(set) var purchases: [PurchaseRecord] = []
    @Published private(set) var catalog: Catalog?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let api: MonetaLabAPI
    private let token: () -> String?
    private let onUnauthenticated: () -> Void

    init(api: MonetaLabAPI, token: @escaping () -> String?, onUnauthenticated: @escaping () -> Void) {
        self.api = api
        self.token = token
        self.onUnauthenticated = onUnauthenticated
    }

    func refresh() async {
        guard let token = token() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let wallet = api.wallet(token: token)
            async let history = api.history(token: token)
            async let purchases = api.purchases(token: token)
            async let catalog = api.catalog()
            (self.wallet, self.history, self.purchases, self.catalog) = try await (wallet, history, purchases, catalog)
            errorMessage = nil
        } catch APIError.unauthenticated {
            onUnauthenticated()
        } catch {
            errorMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    /// Server-returned wallet after a purchase or operation.
    func apply(_ wallet: Wallet) { self.wallet = wallet }
}
