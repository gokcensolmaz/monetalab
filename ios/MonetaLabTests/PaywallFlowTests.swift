import XCTest
@testable import MonetaLab

/// PRD §3.1 and PW-02/PW-03, plus idempotent retries. These tests prove the client never auto-executes a blocked operation.
@MainActor
final class PaywallFlowTests: XCTestCase {
    private var api: FakeAPI!
    private var walletUpdates: [Wallet] = []
    private var signedOut = false
    private var requestCounter = 0

    override func setUp() {
        reset()
    }

    private func reset() {
        api = FakeAPI()
        walletUpdates = []
        signedOut = false
        requestCounter = 0
    }

    private func makeOperation() -> OperationModel {
        let model = OperationModel(api: api, token: { "tok" }, onWallet: { [unowned self] in walletUpdates.append($0) },
                                   onUnauthenticated: { [unowned self] in signedOut = true },
                                   makeRequestId: { [unowned self] in requestCounter += 1; return "req-\(requestCounter)" })
        model.selected = FakeAPI.standard
        return model
    }

    private func makePaywall(required: Int?) -> PaywallModel {
        let model = PaywallModel(required: required, api: api, token: { "tok" }, onUnauthenticated: {}, makeTransactionId: { "tx-\(UUID().uuidString)" })
        model.selectedPackageId = "CREDITS_S"
        return model
    }

    func testRunRequiresExplicitConfirmation() async {
        let op = makeOperation()
        op.requestRun()
        XCTAssertTrue(op.isConfirming)
        XCTAssertEqual(api.runOperationCalls.count, 0, "tapping Run must only ask for confirmation")
    }

    func testInsufficientCreditsOpensPaywallWithRequiredAmount() async {
        let op = makeOperation()
        api.operationResults = [.failure(.insufficientCredits(required: 500, available: 120))]
        await op.confirmRun()
        XCTAssertEqual(op.paywall, OperationModel.PaywallContext(action: FakeAPI.standard, required: 500, available: 120))
        XCTAssertNil(op.lastResult)
        XCTAssertNil(op.pendingRequestId, "a 402 records nothing, so the request id is not kept")
    }

    func testApprovedPurchaseThatCoversCostDismissesPaywallWithoutRunningTheOperation() async {
        let op = makeOperation()
        api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
        await op.confirmRun()
        XCTAssertNotNil(op.paywall)

        let paywall = makePaywall(required: 500)
        api.purchaseResults = [.success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 5000)))]
        let wallet = await paywall.continueTapped()
        XCTAssertEqual(wallet?.total, 5000)
        let dismissed = op.paywallWalletChanged(wallet!)

        XCTAssertTrue(dismissed)
        XCTAssertNil(op.paywall, "paywall closes and the user is back on the operation screen")
        XCTAssertEqual(api.runOperationCalls.count, 1, "the blocked operation must NOT be executed automatically")
        XCTAssertFalse(op.isConfirming, "no confirmation is opened on the user's behalf either")
        XCTAssertNotNil(op.notice)
        XCTAssertEqual(walletUpdates.last?.total, 5000)

        // Explicit re-confirmation runs it, with a fresh request id.
        api.operationResults = [.success(FakeAPI.operationResponse(requestId: "req-2", wallet: FakeAPI.wallet(consumable: 4500)))]
        op.requestRun()
        await op.confirmRun()
        XCTAssertEqual(api.runOperationCalls.map(\.requestId), ["req-1", "req-2"])
        XCTAssertEqual(op.lastResult?.cost, 500)
    }

    func testStillInsufficientAfterPurchaseKeepsPaywallOpen() async {
        let op = makeOperation()
        api.operationResults = [.failure(.insufficientCredits(required: 12000, available: 0))]
        await op.confirmRun()
        let paywall = makePaywall(required: 12000)
        api.purchaseResults = [.success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 5000)))]
        let wallet = await paywall.continueTapped()
        XCTAssertFalse(op.paywallWalletChanged(wallet!))
        XCTAssertEqual(op.paywall?.available, 5000)
        XCTAssertEqual(op.paywall?.required, 12000)
        XCTAssertTrue(paywall.message?.contains(7000.formatted(.number.grouping(.automatic))) ?? false, "tells the user how many credits are still missing; got: \(paywall.message ?? "nil")")
        XCTAssertEqual(api.runOperationCalls.count, 1)
    }

    func testDeclinedAndCancelledPurchasesLeaveBalanceAndPaywallUnchanged() async {
        for outcome in ["DECLINED", "CANCELLED"] {
            reset()
            let op = makeOperation()
            api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
            await op.confirmRun()
            let paywall = makePaywall(required: 500)
            paywall.mockOutcome = outcome == "DECLINED" ? .declined : .cancelled
            api.purchaseResults = [.success(FakeAPI.purchaseResponse(outcome: outcome, granted: 0, wallet: FakeAPI.wallet(consumable: 0)))]
            let wallet = await paywall.continueTapped()
            XCTAssertFalse(op.paywallWalletChanged(wallet!))
            XCTAssertNotNil(op.paywall, "\(outcome): paywall stays open")
            XCTAssertEqual(wallet?.total, 0)
            XCTAssertTrue(paywall.message?.contains("unchanged") ?? false)
            XCTAssertEqual(api.purchaseCalls.first?.outcome.rawValue, outcome)
        }
    }

    func testClosingPaywallDoesNothing() async {
        let op = makeOperation()
        api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
        await op.confirmRun()
        op.closePaywall()
        XCTAssertNil(op.paywall)
        XCTAssertEqual(api.runOperationCalls.count, 1)
        XCTAssertEqual(api.purchaseCalls.count, 0)
    }

    func testNetworkFailureKeepsRequestIdSoRetryIsIdempotent() async {
        let op = makeOperation()
        api.operationResults = [.failure(.transport("offline")),
                                .success(FakeAPI.operationResponse(requestId: "req-1", wallet: FakeAPI.wallet(consumable: 4500)))]
        await op.confirmRun()
        XCTAssertEqual(op.pendingRequestId, "req-1")
        XCTAssertNotNil(op.errorMessage)
        await op.confirmRun()
        XCTAssertEqual(api.runOperationCalls.map(\.requestId), ["req-1", "req-1"], "retry must reuse the same request id")
        XCTAssertNil(op.pendingRequestId)
    }

    func testPurchaseNetworkFailureReusesTransactionIdOnRetry() async {
        let paywall = makePaywall(required: nil)
        api.purchaseResults = [.failure(.transport("offline")),
                               .success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 5000)))]
        _ = await paywall.continueTapped()
        _ = await paywall.continueTapped()
        XCTAssertEqual(api.purchaseCalls.count, 2)
        XCTAssertEqual(api.purchaseCalls[0].transactionId, api.purchaseCalls[1].transactionId)
        // A new definitive purchase gets a new transaction id.
        api.purchaseResults = [.success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 10000)))]
        _ = await paywall.continueTapped()
        XCTAssertNotEqual(api.purchaseCalls[2].transactionId, api.purchaseCalls[1].transactionId)
    }

    /// Review note: repeated paywall navigation. Opening and closing the paywall several times never purchases or
    /// runs anything by itself; each blocked attempt is a fresh request; only the final explicit confirmation spends.
    func testRepeatedPaywallOpenCloseNeverAutoRunsOrPurchases() async {
        let op = makeOperation()
        for attempt in 1...3 {
            api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
            op.requestRun()
            await op.confirmRun()
            XCTAssertEqual(op.paywall?.required, 500, "attempt \(attempt): paywall reopens")
            let paywall = makePaywall(required: 500)
            paywall.tab = .subscription
            paywall.tab = .credits
            op.closePaywall()
            XCTAssertNil(op.paywall)
        }
        XCTAssertEqual(api.purchaseCalls.count, 0, "navigating the paywall alone never purchases")
        XCTAssertEqual(api.runOperationCalls.map(\.requestId), ["req-1", "req-2", "req-3"], "each blocked attempt is a new request")

        // Fourth visit: buy, and the paywall dismisses without running the operation.
        api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
        op.requestRun()
        await op.confirmRun()
        let paywall = makePaywall(required: 500)
        api.purchaseResults = [.success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 5000)))]
        let wallet = await paywall.continueTapped()
        XCTAssertTrue(op.paywallWalletChanged(wallet!))
        XCTAssertEqual(api.runOperationCalls.count, 4, "still no automatic run after the purchase")
        XCTAssertEqual(api.purchaseCalls.count, 1)
    }

    /// Review note: switching tabs, re-tapping Continue and changing the selection while a purchase is in flight.
    func testTabSwitchAndSelectionChangesDuringInFlightPurchaseAreSafe() async {
        let op = makeOperation()
        api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
        await op.confirmRun()
        let paywall = makePaywall(required: 500)
        let gate = Gate()
        api.purchaseGate = gate
        api.purchaseResults = [.failure(.transport("offline")),
                               .success(FakeAPI.purchaseResponse(outcome: "APPROVED", granted: 5000, wallet: FakeAPI.wallet(consumable: 5000)))]

        let inFlight = Task { await paywall.continueTapped() }
        while api.purchaseCalls.isEmpty { await Task.yield() }
        XCTAssertTrue(paywall.isPurchasing)

        paywall.tab = .subscription
        let secondTap = await paywall.continueTapped()
        XCTAssertNil(secondTap, "a second tap while in flight is ignored")
        paywall.selectedPackageId = "CREDITS_L"
        paywall.mockOutcome = .declined
        XCTAssertEqual(paywall.selectedPackageId, "CREDITS_S", "selection is frozen while the purchase is in flight")
        XCTAssertEqual(paywall.mockOutcome, .approved)
        paywall.tab = .credits

        gate.open()
        let firstResult = await inFlight.value
        XCTAssertNil(firstResult, "network failure: outcome unknown")
        XCTAssertEqual(api.purchaseCalls.count, 1, "only one request was sent while in flight")
        XCTAssertFalse(paywall.isPurchasing)
        XCTAssertNotNil(paywall.pendingTransactionId, "transaction id kept for an idempotent retry")
        XCTAssertNotNil(op.paywall, "paywall stays open on an unknown outcome")

        let wallet = await paywall.continueTapped()
        XCTAssertEqual(api.purchaseCalls.count, 2)
        XCTAssertEqual(api.purchaseCalls[0].transactionId, api.purchaseCalls[1].transactionId, "retry reuses the same transaction id")
        XCTAssertEqual(api.purchaseCalls[1].packageId, "CREDITS_S")
        XCTAssertEqual(api.purchaseCalls[1].outcome, .approved)
        XCTAssertTrue(op.paywallWalletChanged(wallet!))
        XCTAssertEqual(api.runOperationCalls.count, 1, "the blocked operation is still not run automatically")
    }

    func testUnauthenticatedOperationEndsSession() async {
        let op = makeOperation()
        api.operationResults = [.failure(.unauthenticated)]
        await op.confirmRun()
        XCTAssertTrue(signedOut)
    }
}
