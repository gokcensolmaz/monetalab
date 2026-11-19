import XCTest

/// End-to-end M1 journey through the real app UI against a REAL running MonetaLab backend (no fakes).
/// Backend URL: TEST_RUNNER_MONETALAB_API_BASE_URL (xcodebuild passes TEST_RUNNER_-prefixed variables to the runner),
/// default http://127.0.0.1:3000. See README "iOS UI test".
final class PrimaryJourneyUITests: XCTestCase {
    private var app: XCUIApplication!
    private var localeArguments: [String] = []

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // Deterministic number formatting ("5,000") regardless of the simulator's region.
        localeArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["MONETALAB_API_BASE_URL"] =
            ProcessInfo.processInfo.environment["MONETALAB_API_BASE_URL"] ?? "http://127.0.0.1:3000"
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func waitFor(_ element: XCUIElement, _ timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "missing \(element)", file: file, line: line)
    }

    private func waitForLabel(_ id: String, _ expected: String, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", expected)
        let exp = XCTNSPredicateExpectation(predicate: predicate, object: element(id))
        XCTAssertEqual(XCTWaiter().wait(for: [exp], timeout: timeout), .completed,
                       "\(id) label is '\(element(id).exists ? element(id).label : "<not in the UI tree>")', expected '\(expected)'",
                       file: file, line: line)
    }

    // MARK: iOS 26+ simulator behaviour (observed on Xcode 27.2 / iOS 27.2; see docs/m2-verification.md §4)

    /// iOS 26+ offers to save a newly created account's password: a "Save Password?" sheet (Passwords app) appears after
    /// Create Account with a variable delay (observed about 18 s to over 40 s), and while it is up every tap on the app
    /// is lost. It is OS behaviour, not app behaviour (the app's username/password AutoFill content types are kept).
    /// The journeys wait for it right after sign-up and answer "Not Now", so it never races a later step.
    private func answerSavePasswordPromptAfterSignUp() {
        if app.sheets["Save Password?"].waitForExistence(timeout: 90) { dismissSavePasswordPromptIfShown() }
    }

    /// Backstop used by every helper below: answers the prompt with "Not Now" if it is on screen right now.
    private func dismissSavePasswordPromptIfShown(file: StaticString = #filePath, line: UInt = #line) {
        let prompt = app.sheets["Save Password?"]
        guard prompt.exists else { return }
        // A tap that lands while the prompt is still animating in is ignored by iOS (run 12: the sheet stayed up
        // for 10 s after one tap). Re-tap only while the prompt is still there, then assert it is gone.
        var result = XCTWaiter.Result.timedOut
        for _ in 0..<3 where result != .completed {
            let notNow = prompt.buttons["Not Now"]
            if notNow.exists { notNow.tap() }
            let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: prompt)
            result = XCTWaiter().wait(for: [gone], timeout: 5)
        }
        XCTAssertEqual(result, .completed, "Save Password prompt still shown", file: file, line: line)
    }

    /// iOS 26+ presents `confirmationDialog` as a popover whose accessibility tree contains the Confirm button twice
    /// (same identifier and frame), so a plain query is ambiguous. Waits for it, then taps the first match.
    private func confirmSpend(file: StaticString = #filePath, line: UInt = #line) {
        dismissSavePasswordPromptIfShown(file: file, line: line)
        let confirm = app.buttons["operation.confirm"].firstMatch
        waitFor(confirm, file: file, line: line)
        confirm.tap()
    }

    /// On iOS 26+ XCTest often cannot compute a hit point for tab-bar buttons (`isHittable` stays false, the tab bar's
    /// own frame can be reported as {inf, inf}, and `tap()` logs "Computed hit point {-1, -1}" and is silently dropped).
    /// So the tab is tapped at the centre of its reported frame. Selecting a tab is idempotent, so the tap is repeated
    /// (at most 3 times) only while the tab is still not selected; the test then asserts the tab really is selected.
    private func selectTab(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let tab = app.tabBars.buttons[name]
        waitFor(tab, file: file, line: line)
        let selected = NSPredicate(format: "isSelected == true")
        for _ in 0..<3 where !tab.isSelected {
            dismissSavePasswordPromptIfShown(file: file, line: line)
            tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: selected, object: tab)], timeout: 5)
        }
        XCTAssertTrue(tab.isSelected, "tab \(name) not selected", file: file, line: line)
    }

    /// SwiftUI `List` is lazy: on the iOS 26+ iPhone layout the paywall's lower sections (Continue, rewarded ad) start
    /// below the fold and are not in the accessibility tree until scrolled into view. Scrolls the sheet in small steps
    /// (down, then back up) until the element lies fully inside the visible band of the window (clear of the navigation
    /// bar and the home indicator), and fails if it never does. Visibility is judged from the element's frame because
    /// `isHittable` is unreliable for segmented-control segments on iOS 26+. The drag runs along the right-hand margin so
    /// it never drags across a segmented control (which would change a mock outcome).
    @discardableResult
    private func reveal(_ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let window = app.windows.firstMatch.frame
        let band = CGRect(x: window.minX, y: window.minY + 120, width: window.width, height: window.height - 180)
        func onScreen() -> Bool { target.exists && band.contains(target.frame) }
        dismissSavePasswordPromptIfShown(file: file, line: line)
        if target.waitForExistence(timeout: 5), onScreen() { return target }
        let upper = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.35))
        let lower = app.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.65))
        for _ in 0..<6 where !onScreen() {
            dismissSavePasswordPromptIfShown(file: file, line: line)
            lower.press(forDuration: 0.05, thenDragTo: upper)
        }
        for _ in 0..<10 where !onScreen() {
            dismissSavePasswordPromptIfShown(file: file, line: line)
            upper.press(forDuration: 0.05, thenDragTo: lower)
        }
        XCTAssertTrue(onScreen(), "\(target) never came fully on screen", file: file, line: line)
        return target
    }

    func testRegisterBuyThroughPaywallReturnWithoutAutoRunThenConfirmAndSignOut() throws {
        app.launchArguments = ["--reset-session"] + localeArguments
        app.launch()

        // Register (the app signs in right after creating the account).
        let email = "ui-\(UUID().uuidString.prefix(8).lowercased())@test.invalid"
        waitFor(element("auth.email"))
        element("auth.email").tap()
        element("auth.email").typeText(email)
        element("auth.password").tap()
        element("auth.password").typeText("correct horse battery staple")
        element("auth.register").tap()

        // New wallet: four zero buckets, total 0, from the server.
        waitForLabel("wallet.total", "0 credits")
        for id in ["subscription", "consumable", "reward", "promotional"] { waitForLabel("wallet.balance.\(id)", "0") }
        answerSavePasswordPromptAfterSignUp()

        // Choose Standard (500) and confirm explicitly → 402 → paywall.
        selectTab("Process")
        waitFor(element("operation.option.STANDARD"))
        element("operation.option.STANDARD").tap()
        element("operation.run").tap()
        confirmSpend()

        waitFor(element("paywall.required"))
        XCTAssertTrue(element("paywall.required").label.contains("500"))

        // M2: Watch Ad is offered (credits insufficient, quota left), with the server's UTC quota.
        reveal(element("paywall.watchAd"))
        reveal(element("paywall.adQuota"))
        waitForLabel("paywall.adQuota", "10 of 10 rewarded ads left today (UTC)")

        // Subscription tab: the three weekly plans; the trial message is shown because this new user is eligible.
        reveal(app.segmentedControls.buttons["Subscription"]).tap()
        reveal(element("paywall.plan.BASIC_WEEKLY"))
        XCTAssertTrue(reveal(element("paywall.plan.ULTRA_WEEKLY")).exists)
        reveal(element("paywall.trialMessage"))
        XCTAssertFalse(reveal(element("paywall.subscriptionContinue")).isEnabled, "nothing selected yet")

        // Credits tab: a CANCELLED mock purchase changes nothing and keeps the paywall open.
        reveal(app.segmentedControls.buttons["Credits"]).tap()
        reveal(element("paywall.package.CREDITS_S")).tap()
        reveal(app.segmentedControls.buttons["Cancelled"]).tap()
        reveal(element("paywall.continue")).tap()
        reveal(element("paywall.message"))
        XCTAssertTrue(element("paywall.message").label.contains("cancelled"))
        XCTAssertTrue(reveal(element("paywall.required")).exists, "paywall stays open after a cancelled purchase")

        // APPROVED purchase covers the cost → paywall closes → back on the operation screen, NOT executed.
        reveal(app.segmentedControls.buttons["Approved"]).tap()
        reveal(element("paywall.continue")).tap()
        waitFor(element("operation.notice"))
        XCTAssertFalse(element("paywall.required").exists)
        XCTAssertFalse(element("operation.result").exists, "the blocked operation must not run automatically")
        waitForLabel("operation.available", "5,000 credits")

        // Explicit re-confirmation runs it: 500 debited from CONSUMABLE on the server.
        element("operation.run").tap()
        confirmSpend()
        waitFor(element("operation.result"))
        waitForLabel("operation.available", "4,500 credits")

        // Wallet and history reflect the server state.
        selectTab("Wallet")
        waitForLabel("wallet.balance.consumable", "4,500")
        selectTab("History")
        waitFor(element("history.entry"))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "history.entry").count, 2) // grant + debit
        app.segmentedControls.buttons["Purchases"].tap()
        waitFor(element("history.purchase"))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "history.purchase").count, 2) // cancelled + approved

        // Session persists across relaunch (token stored in the Keychain).
        app.terminate()
        app.launchArguments = localeArguments
        app.launch()
        waitForLabel("wallet.total", "4,500 credits")

        // Sign out returns to the sign-in screen.
        selectTab("Account")
        XCTAssertEqual(element("account.email").label, email)
        element("account.signOut").tap()
        waitFor(element("auth.email"))
    }

    /// M2 journey: rewarded ad (incomplete → nothing; completed → +100 → paywall closes, no auto-run), then the Basic
    /// free trial from the paywall, then the Plan tab (status, cancel auto-renew keeps the entitlement).
    func testRewardedAdThenTrialFromPaywallThenCancelAutoRenew() throws {
        app.launchArguments = ["--reset-session"] + localeArguments
        app.launch()
        let email = "ui-m2-\(UUID().uuidString.prefix(8).lowercased())@test.invalid"
        waitFor(element("auth.email"))
        element("auth.email").tap()
        element("auth.email").typeText(email)
        element("auth.password").tap()
        element("auth.password").typeText("correct horse battery staple")
        element("auth.register").tap()
        waitForLabel("wallet.total", "0 credits")
        answerSavePasswordPromptAfterSignUp()

        // Basic processing (100) is blocked → paywall.
        selectTab("Process")
        waitFor(element("operation.option.BASIC"))
        element("operation.option.BASIC").tap()
        element("operation.run").tap()
        confirmSpend()
        waitFor(element("paywall.required"))
        reveal(element("paywall.adQuota"))
        waitForLabel("paywall.adQuota", "10 of 10 rewarded ads left today (UTC)")

        // ADS-02: an ad closed early grants nothing, uses no quota, paywall stays (PW-03).
        reveal(app.segmentedControls.buttons["Closed early"]).tap()
        reveal(element("paywall.watchAd")).tap()
        reveal(element("paywall.adMessage"))
        waitForLabel("paywall.adMessage", "The ad was not completed. No credits were added.")
        reveal(element("paywall.adQuota"))
        waitForLabel("paywall.adQuota", "10 of 10 rewarded ads left today (UTC)")
        XCTAssertTrue(reveal(element("paywall.required")).exists)

        // ADS-01 + PW-02: a completed ad grants 100 → enough for Basic → paywall closes, operation NOT run.
        reveal(app.segmentedControls.buttons["Completed"]).tap()
        reveal(element("paywall.watchAd")).tap()
        waitFor(element("operation.notice"))
        XCTAssertFalse(element("paywall.required").exists)
        XCTAssertFalse(element("operation.result").exists, "the blocked operation must not run automatically")
        waitForLabel("operation.available", "100 credits")

        // Standard (500) is blocked → Subscription tab → Basic trial (TRIAL-01: 1,000 credits) → paywall closes.
        element("operation.option.STANDARD").tap()
        element("operation.run").tap()
        confirmSpend()
        waitFor(element("paywall.required"))
        reveal(app.segmentedControls.buttons["Subscription"]).tap()
        reveal(element("paywall.trialMessage"))
        reveal(element("paywall.plan.BASIC_WEEKLY")).tap()
        reveal(element("paywall.subscriptionContinue")).tap()
        waitFor(element("operation.notice"))
        XCTAssertFalse(element("operation.result").exists)
        waitForLabel("operation.available", "1,100 credits")
        element("operation.run").tap()
        confirmSpend()
        waitFor(element("operation.result"))
        waitForLabel("operation.available", "600 credits") // 500 from SUBSCRIPTION first

        // Plan tab: free trial status; cancel auto-renew keeps the entitlement; no trial message any more.
        selectTab("Plan")
        waitForLabel("plan.status", "Basic · Free trial")
        XCTAssertFalse(element("plan.trialMessage").exists)
        element("plan.cancel").tap()
        waitForLabel("plan.autoRenew", "Auto-renew off")
        waitForLabel("plan.status", "Basic · Free trial")
        waitFor(element("plan.resume"))
    }

    func testWrongPasswordShowsErrorAndStaysSignedOut() throws {
        app.launchArguments = ["--reset-session"] + localeArguments
        app.launch()
        waitFor(element("auth.email"))
        element("auth.email").tap()
        element("auth.email").typeText("nobody-\(UUID().uuidString.prefix(6).lowercased())@test.invalid")
        element("auth.password").tap()
        element("auth.password").typeText("wrong password 1")
        element("auth.signIn").tap()
        waitForLabel("auth.error", "Email or password is incorrect.")
    }
}
