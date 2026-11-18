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
                       "\(id) label is '\(element(id).label)', expected '\(expected)'", file: file, line: line)
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

        // Choose Standard (500) and confirm explicitly → 402 → paywall.
        app.tabBars.buttons["Process"].tap()
        waitFor(element("operation.option.STANDARD"))
        element("operation.option.STANDARD").tap()
        element("operation.run").tap()
        waitFor(app.buttons["Confirm"])
        app.buttons["Confirm"].tap()

        waitFor(element("paywall.required"))
        XCTAssertTrue(element("paywall.required").label.contains("500"))

        // Watch Ad is visible but not available in M1.
        waitFor(element("paywall.watchAd"))
        XCTAssertFalse(element("paywall.watchAd").isEnabled)

        // Subscription tab: preview plans, purchase unavailable.
        app.segmentedControls.buttons["Subscription"].tap()
        waitFor(element("paywall.subscription.BASIC_WEEKLY"))
        XCTAssertTrue(element("paywall.subscription.ULTRA_WEEKLY").exists)
        XCTAssertFalse(element("paywall.subscriptionContinue").isEnabled)

        // Credits tab: a CANCELLED mock purchase changes nothing and keeps the paywall open.
        app.segmentedControls.buttons["Credits"].tap()
        element("paywall.package.CREDITS_S").tap()
        app.segmentedControls.buttons["Cancelled"].tap()
        element("paywall.continue").tap()
        waitFor(element("paywall.message"))
        XCTAssertTrue(element("paywall.message").label.contains("cancelled"))
        XCTAssertTrue(element("paywall.required").exists, "paywall stays open after a cancelled purchase")

        // APPROVED purchase covers the cost → paywall closes → back on the operation screen, NOT executed.
        app.segmentedControls.buttons["Approved"].tap()
        element("paywall.continue").tap()
        waitFor(element("operation.notice"))
        XCTAssertFalse(element("paywall.required").exists)
        XCTAssertFalse(element("operation.result").exists, "the blocked operation must not run automatically")
        waitForLabel("operation.available", "5,000 credits")

        // Explicit re-confirmation runs it: 500 debited from CONSUMABLE on the server.
        element("operation.run").tap()
        waitFor(app.buttons["Confirm"])
        app.buttons["Confirm"].tap()
        waitFor(element("operation.result"))
        waitForLabel("operation.available", "4,500 credits")

        // Wallet and history reflect the server state.
        app.tabBars.buttons["Wallet"].tap()
        waitForLabel("wallet.balance.consumable", "4,500")
        app.tabBars.buttons["History"].tap()
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
        app.tabBars.buttons["Account"].tap()
        XCTAssertEqual(element("account.email").label, email)
        element("account.signOut").tap()
        waitFor(element("auth.email"))
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
