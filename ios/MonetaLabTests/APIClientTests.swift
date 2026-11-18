import XCTest
@testable import MonetaLab

/// HTTP contract mapping, using a stubbed URLProtocol (no network).
final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var lastRequest: URLRequest?
    static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            stream.close()
            Self.lastBody = data
        } else {
            Self.lastBody = request.httpBody
        }
        let (status, data) = Self.handler?(request) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    private var client: HTTPAPIClient!

    override func setUp() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        client = HTTPAPIClient(baseURL: URL(string: "http://127.0.0.1:3000")!, session: URLSession(configuration: config))
    }

    private func respond(_ status: Int, _ json: String) {
        StubURLProtocol.handler = { _ in (status, Data(json.utf8)) }
    }

    func testInsufficientCredits402MapsToTypedError() async {
        respond(402, #"{"error":{"code":"INSUFFICIENT_CREDITS","message":"Not enough credits for this operation","required":800,"available":799}}"#)
        do {
            _ = try await client.runOperation(token: "t", action: "ADVANCED", requestId: "r1")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? APIError, .insufficientCredits(required: 800, available: 799))
        }
    }

    func testUnauthorized401MapsToUnauthenticated() async {
        respond(401, #"{"error":{"code":"UNAUTHENTICATED","message":"Authentication required"}}"#)
        do { _ = try await client.wallet(token: "t"); XCTFail("expected an error") } catch {
            XCTAssertEqual(error as? APIError, .unauthenticated)
        }
    }

    func testServerErrorKeepsCodeAndMessage() async {
        respond(409, #"{"error":{"code":"TRANSACTION_CONFLICT","message":"This transaction id was already used with a different request"}}"#)
        do { _ = try await client.purchase(token: "t", packageId: "CREDITS_S", transactionId: "x", mockOutcome: .approved); XCTFail() } catch {
            XCTAssertEqual(error as? APIError, .server(status: 409, code: "TRANSACTION_CONFLICT", message: "This transaction id was already used with a different request"))
        }
    }

    func testWalletDecodingAndBearerHeader() async throws {
        respond(200, #"{"wallet":{"balances":{"SUBSCRIPTION":200,"CONSUMABLE":300,"REWARD":400,"PROMOTIONAL":1000},"total":1900},"bucketPriority":["SUBSCRIPTION","CONSUMABLE","REWARD","PROMOTIONAL"]}"#)
        let wallet = try await client.wallet(token: "abc")
        XCTAssertEqual(wallet, Wallet(balances: Balances(subscription: 200, consumable: 300, reward: 400, promotional: 1000), total: 1900))
        XCTAssertEqual(StubURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
        XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "/wallet")
    }

    func testPurchaseSendsMockOutcomeAndTransactionId() async throws {
        respond(201, #"{"purchase":{"id":"p","transactionId":"tx-1","packageId":"CREDITS_M","credits":7000,"outcome":"CANCELLED","createdAt":"now"},"creditsGranted":0,"replayed":false,"wallet":{"balances":{"SUBSCRIPTION":0,"CONSUMABLE":0,"REWARD":0,"PROMOTIONAL":0},"total":0}}"#)
        let response = try await client.purchase(token: "t", packageId: "CREDITS_M", transactionId: "tx-1", mockOutcome: .cancelled)
        XCTAssertEqual(response.creditsGranted, 0)
        let sent = try JSONSerialization.jsonObject(with: StubURLProtocol.lastBody ?? Data()) as? [String: String]
        XCTAssertEqual(sent, ["packageId": "CREDITS_M", "transactionId": "tx-1", "mockOutcome": "CANCELLED"])
    }

    func testTransportFailureMapsToTransportError() async {
        let client = HTTPAPIClient(baseURL: URL(string: "http://127.0.0.1:1")!) // nothing listens on port 1
        do { _ = try await client.catalog(); XCTFail() } catch {
            guard case .transport = error as? APIError else { return XCTFail("expected transport error, got \(error)") }
        }
    }

    func testBaseURLResolutionPrefersLaunchEnvironment() {
        XCTAssertEqual(HTTPAPIClient.configuredBaseURL(environment: ["MONETALAB_API_BASE_URL": "http://127.0.0.1:4321"]).absoluteString,
                       "http://127.0.0.1:4321")
        XCTAssertEqual(HTTPAPIClient.configuredBaseURL(environment: [:]).absoluteString, "http://127.0.0.1:3000")
    }
}

@MainActor
final class AppModelTests: XCTestCase {
    func testRestoreDiscardsRevokedOrExpiredToken() async {
        let api = FakeAPI()
        api.meResult = .failure(.unauthenticated)
        let store = InMemoryTokenStore(token: "old")
        let app = AppModel(api: api, tokenStore: store)
        await app.restore()
        XCTAssertEqual(app.state, .signedOut)
        XCTAssertNil(store.load())
    }

    func testRestoreWithValidTokenSignsIn() async {
        let api = FakeAPI()
        let app = AppModel(api: api, tokenStore: InMemoryTokenStore(token: "good"))
        await app.restore()
        XCTAssertEqual(app.user?.email, "qa@test.invalid")
    }

    func testRegisterThenSignInPersistsTokenAndSignOutClearsIt() async {
        let api = FakeAPI()
        let store = InMemoryTokenStore()
        let app = AppModel(api: api, tokenStore: store)
        await app.register(email: "qa@test.invalid", password: "password123")
        XCTAssertEqual(api.registerCalls, 1)
        XCTAssertEqual(store.load(), "tok")
        await app.signOut()
        XCTAssertEqual(api.logoutCalls, 1)
        XCTAssertNil(store.load())
        XCTAssertEqual(app.state, .signedOut)
    }

    func testFailedLoginShowsMessageAndStaysSignedOut() async {
        let api = FakeAPI()
        api.loginResult = .failure(.unauthenticated)
        let app = AppModel(api: api, tokenStore: InMemoryTokenStore())
        await app.restore()
        await app.signIn(email: "qa@test.invalid", password: "wrong-password")
        XCTAssertEqual(app.state, .signedOut)
        XCTAssertEqual(app.authError, "Email or password is incorrect.")
    }
}
