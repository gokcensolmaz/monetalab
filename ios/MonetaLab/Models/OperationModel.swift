import Foundation

/// The operation screen: choose an action, confirm it explicitly, run it on the server.
/// On 402 INSUFFICIENT_CREDITS it opens the paywall (PRD §3.1). When purchases make the balance sufficient, the
/// paywall closes and the user returns here. The blocked operation is **never** executed automatically; it only
/// runs after a new explicit confirmation.
@MainActor
final class OperationModel: ObservableObject {
    struct PaywallContext: Equatable, Identifiable {
        let action: OperationOption
        let required: Int
        var available: Int
        var id: String { action.id }
    }

    @Published var selected: OperationOption?
    @Published var isConfirming = false
    @Published private(set) var isRunning = false
    @Published private(set) var lastResult: OperationResult?
    @Published var paywall: PaywallContext?
    @Published private(set) var notice: String?
    @Published var errorMessage: String?

    private let api: MonetaLabAPI
    private let token: () -> String?
    private let onWallet: (Wallet) -> Void
    private let onUnauthenticated: () -> Void
    /// Kept only while the outcome of a submitted run is unknown (network failure), so a retry is idempotent.
    private(set) var pendingRequestId: String?
    private let makeRequestId: () -> String

    init(api: MonetaLabAPI,
         token: @escaping () -> String?,
         onWallet: @escaping (Wallet) -> Void,
         onUnauthenticated: @escaping () -> Void,
         makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.api = api
        self.token = token
        self.onWallet = onWallet
        self.onUnauthenticated = onUnauthenticated
        self.makeRequestId = makeRequestId
    }

    /// Step 1: the user taps Run. This only asks for confirmation.
    func requestRun() {
        guard selected != nil, !isRunning else { return }
        errorMessage = nil
        isConfirming = true
    }

    /// Step 2: the user explicitly confirms. This is the only path that spends credits.
    func confirmRun() async {
        isConfirming = false
        guard let action = selected, let token = token(), !isRunning else { return }
        isRunning = true
        notice = nil
        errorMessage = nil
        defer { isRunning = false }
        let requestId = pendingRequestId ?? makeRequestId()
        pendingRequestId = requestId
        do {
            let response = try await api.runOperation(token: token, action: action.id, requestId: requestId)
            pendingRequestId = nil
            lastResult = response.operation
            onWallet(response.wallet)
        } catch let APIError.insufficientCredits(required, available) {
            pendingRequestId = nil // a 402 records nothing on the server
            lastResult = nil
            paywall = PaywallContext(action: action, required: required, available: available)
        } catch APIError.unauthenticated {
            pendingRequestId = nil
            onUnauthenticated()
        } catch APIError.transport(let detail) {
            // Outcome unknown: keep the request id so retrying cannot double-spend.
            errorMessage = APIError.transport(detail).userMessage
        } catch {
            pendingRequestId = nil
            errorMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    /// Called by the paywall after any purchase attempt, with the wallet re-fetched from the server.
    /// Returns true when the paywall was dismissed because credits are now sufficient.
    @discardableResult
    func paywallWalletChanged(_ wallet: Wallet) -> Bool {
        onWallet(wallet)
        guard var context = paywall else { return false }
        context.available = wallet.total
        if wallet.total >= context.required {
            paywall = nil
            notice = "You now have \(wallet.total.credits) credits. Tap Run to confirm \(context.action.name) again."
            return true // deliberately does NOT call confirmRun()
        }
        paywall = context
        return false
    }

    func closePaywall() {
        paywall = nil
    }
}
