import Foundation
@testable import MonetaLab

/// Scriptable in-memory API for view-model tests. It records every call so tests can prove what did NOT happen
/// (for example, that the operation was never re-run automatically).
final class FakeAPI: MonetaLabAPI {
    var wallet = Wallet(balances: .zero, total: 0)
    var operationResults: [Result<OperationResponse, APIError>] = []
    var purchaseResults: [Result<PurchaseResponse, APIError>] = []
    var meResult: Result<User, APIError> = .success(User(id: "u1", email: "qa@test.invalid", createdAt: "2026-11-17T00:00:00Z"))
    var loginResult: Result<LoginResponse, APIError> = .success(
        LoginResponse(token: "tok", expiresAt: "2026-11-24T00:00:00Z", user: User(id: "u1", email: "qa@test.invalid", createdAt: "2026-11-17T00:00:00Z")))

    private(set) var runOperationCalls: [(action: String, requestId: String)] = []
    private(set) var purchaseCalls: [(packageId: String, transactionId: String, outcome: MockOutcome)] = []
    private(set) var logoutCalls = 0
    private(set) var registerCalls = 0
    /// When set, purchase() suspends after recording the call until the gate is opened (simulates an in-flight request).
    var purchaseGate: Gate?

    func register(email: String, password: String) async throws -> User { registerCalls += 1; return try meResult.get() }
    func login(email: String, password: String) async throws -> LoginResponse { try loginResult.get() }
    func me(token: String) async throws -> User { try meResult.get() }
    func logout(token: String) async throws { logoutCalls += 1 }
    func catalog() async throws -> Catalog { Self.catalog }
    func wallet(token: String) async throws -> Wallet { wallet }
    func history(token: String) async throws -> [HistoryEntry] { [] }
    func purchases(token: String) async throws -> [PurchaseRecord] { [] }

    func purchase(token: String, packageId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> PurchaseResponse {
        purchaseCalls.append((packageId, transactionId, mockOutcome))
        if let purchaseGate { await purchaseGate.wait() }
        let response = try purchaseResults.removeFirst().get()
        wallet = response.wallet
        return response
    }

    func runOperation(token: String, action: String, requestId: String) async throws -> OperationResponse {
        runOperationCalls.append((action, requestId))
        let response = try operationResults.removeFirst().get()
        wallet = response.wallet
        return response
    }

    static let standard = OperationOption(id: "STANDARD", name: "Standard processing", cost: 500)
    static let catalog = Catalog(
        consumables: [CreditPackage(id: "CREDITS_S", name: "Credits S", credits: 5000, available: true)],
        subscriptions: [],
        rewardedAd: RewardedAdPreview(label: "Watch an Ad — Earn 100 Credits", credits: 100, available: false, availability: "M2"),
        operations: [standard])

    static func wallet(consumable: Int) -> Wallet {
        Wallet(balances: Balances(subscription: 0, consumable: consumable, reward: 0, promotional: 0), total: consumable)
    }

    static func purchaseResponse(outcome: String, granted: Int, wallet: Wallet) -> PurchaseResponse {
        PurchaseResponse(purchase: PurchaseInfo(id: "p1", transactionId: "t1", packageId: "CREDITS_S", credits: 5000, outcome: outcome, createdAt: "now"),
                         creditsGranted: granted, replayed: false, wallet: wallet)
    }

    static func operationResponse(requestId: String, wallet: Wallet) -> OperationResponse {
        OperationResponse(operation: OperationResult(id: "o1", requestId: requestId, action: "STANDARD", cost: 500, createdAt: "now",
                                                     debits: Balances(subscription: 0, consumable: 500, reward: 0, promotional: 0),
                                                     result: .init(status: "COMPLETED", output: "simulated")),
                          replayed: false, wallet: wallet)
    }
}

/// A one-shot async gate for holding a fake request in flight.
@MainActor
final class Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var isOpen = false
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func open() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}
