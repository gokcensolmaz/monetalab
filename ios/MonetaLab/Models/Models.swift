import Foundation

// Wire models for the MonetaLab M1 REST API. The backend is the system of record (CLAUDE.md rule 1):
// the app only displays balances returned by the server and never computes or grants credits itself.

struct User: Codable, Equatable {
    let id: String
    let email: String
    let createdAt: String
}

struct LoginResponse: Codable, Equatable {
    let token: String
    let expiresAt: String
    let user: User
}

struct Balances: Codable, Equatable {
    var subscription: Int
    var consumable: Int
    var reward: Int
    var promotional: Int

    enum CodingKeys: String, CodingKey {
        case subscription = "SUBSCRIPTION", consumable = "CONSUMABLE", reward = "REWARD", promotional = "PROMOTIONAL"
    }

    static let zero = Balances(subscription: 0, consumable: 0, reward: 0, promotional: 0)
}

struct Wallet: Codable, Equatable {
    var balances: Balances
    var total: Int
}

struct WalletResponse: Codable { let wallet: Wallet }

struct HistoryEntry: Codable, Equatable, Identifiable {
    struct PurchaseRef: Codable, Equatable { let id: String; let packageId: String; let transactionId: String }
    struct OperationRef: Codable, Equatable { let id: String; let action: String; let requestId: String; let cost: Int }
    let id: Int
    let createdAt: String
    let type: String
    let bucket: String
    let delta: Int
    let purchase: PurchaseRef?
    let operation: OperationRef?
    let seedReason: String?
}

struct HistoryResponse: Codable { let entries: [HistoryEntry]; let nextBefore: Int? }

struct PurchaseRecord: Codable, Equatable, Identifiable {
    let id: String
    let transactionId: String
    let packageId: String
    let credits: Int
    let outcome: String
    let createdAt: String
    let creditsGranted: Int
}

struct PurchasesResponse: Codable { let purchases: [PurchaseRecord] }

struct CreditPackage: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let credits: Int
    let available: Bool
}

struct SubscriptionPreview: Codable, Equatable, Identifiable {
    struct IntroductoryOffer: Codable, Equatable { let description: String; let credits: Int; let days: Int }
    let id: String
    let name: String
    let period: String
    let creditsPerPeriod: Int
    let introductoryOffer: IntroductoryOffer?
    let available: Bool
    let availability: String
}

struct RewardedAdPreview: Codable, Equatable {
    let label: String
    let credits: Int
    let available: Bool
    let availability: String
}

struct OperationOption: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let cost: Int
}

struct Catalog: Codable, Equatable {
    let consumables: [CreditPackage]
    let subscriptions: [SubscriptionPreview]
    let rewardedAd: RewardedAdPreview
    let operations: [OperationOption]
}

/// Deterministic outcome requested from the backend's **mock** billing provider (M1 only, never real payments).
enum MockOutcome: String, Codable, CaseIterable, Identifiable {
    case approved = "APPROVED", declined = "DECLINED", cancelled = "CANCELLED"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .approved: return "Approved"
        case .declined: return "Declined"
        case .cancelled: return "Cancelled"
        }
    }
}

struct PurchaseInfo: Codable, Equatable {
    let id: String
    let transactionId: String
    let packageId: String
    let credits: Int
    let outcome: String
    let createdAt: String
}

struct PurchaseResponse: Codable, Equatable {
    let purchase: PurchaseInfo
    let creditsGranted: Int
    let replayed: Bool
    let wallet: Wallet
}

struct OperationResult: Codable, Equatable {
    struct Output: Codable, Equatable { let status: String; let output: String }
    let id: String
    let requestId: String
    let action: String
    let cost: Int
    let createdAt: String
    let debits: Balances
    let result: Output
}

struct OperationResponse: Codable, Equatable {
    let operation: OperationResult
    let replayed: Bool
    let wallet: Wallet
}

extension Int {
    /// "5,000"-style formatting for credit amounts.
    var credits: String { formatted(.number.grouping(.automatic)) }
}
