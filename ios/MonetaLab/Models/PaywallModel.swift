import Foundation

/// Paywall state: Subscription | Credits tabs (PRD §3.1, D-003).
/// - Subscription plans are M1 previews only (purchase unavailable).
/// - Credits packs are purchasable through the backend's deterministic mock billing provider.
/// - "Watch an Ad — Earn 100 Credits" is shown but unavailable until M2.
@MainActor
final class PaywallModel: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable {
        case subscription = "Subscription", credits = "Credits"
        var id: String { rawValue }
    }

    @Published var tab: Tab = .credits
    /// Selection is frozen while a purchase is in flight: the pending transaction id must stay bound to what was sent,
    /// so a retry after an unknown outcome stays idempotent on the server.
    /// (`@Published` re-runs `didSet` on a write-back inside the observer, so the revert is guarded.)
    @Published var selectedPackageId: String? {
        didSet {
            guard !isReverting, oldValue != selectedPackageId else { return }
            if isPurchasing { revert { selectedPackageId = oldValue } } else { pendingTransactionId = nil }
        }
    }
    @Published var mockOutcome: MockOutcome = .approved {
        didSet {
            guard !isReverting, oldValue != mockOutcome else { return }
            if isPurchasing { revert { mockOutcome = oldValue } } else { pendingTransactionId = nil }
        }
    }
    private var isReverting = false
    private func revert(_ body: () -> Void) {
        isReverting = true
        body()
        isReverting = false
    }
    @Published private(set) var isPurchasing = false
    @Published private(set) var message: String?

    let required: Int?
    private let api: MonetaLabAPI
    private let token: () -> String?
    private let onUnauthenticated: () -> Void
    private let makeTransactionId: () -> String
    /// Reused only when a purchase's outcome is unknown (network failure), so the retry is idempotent on the server.
    private(set) var pendingTransactionId: String?

    init(required: Int?, api: MonetaLabAPI, token: @escaping () -> String?, onUnauthenticated: @escaping () -> Void,
         makeTransactionId: @escaping () -> String = { "ios-\(UUID().uuidString)" }) {
        self.required = required
        self.api = api
        self.token = token
        self.onUnauthenticated = onUnauthenticated
        self.makeTransactionId = makeTransactionId
    }

    /// Continue: purchase the selected pack. Returns the server's wallet after the attempt (unchanged if not approved).
    func continueTapped() async -> Wallet? {
        guard let packageId = selectedPackageId, let token = token(), !isPurchasing else { return nil }
        isPurchasing = true
        message = nil
        defer { isPurchasing = false }
        let transactionId = pendingTransactionId ?? makeTransactionId()
        pendingTransactionId = transactionId
        do {
            let response = try await api.purchase(token: token, packageId: packageId, transactionId: transactionId, mockOutcome: mockOutcome)
            pendingTransactionId = nil
            switch response.purchase.outcome {
            case "APPROVED": message = "Added \(response.creditsGranted.credits) credits."
            case "CANCELLED": message = "Purchase cancelled. Your balance is unchanged."
            default: message = "Payment declined. Your balance is unchanged."
            }
            if let required, response.wallet.total < required {
                message = (message ?? "") + " You still need \((required - response.wallet.total).credits) more credits."
            }
            return response.wallet
        } catch APIError.unauthenticated {
            pendingTransactionId = nil
            onUnauthenticated()
        } catch APIError.transport(let detail) {
            message = APIError.transport(detail).userMessage
        } catch {
            pendingTransactionId = nil
            message = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        return nil
    }
}
