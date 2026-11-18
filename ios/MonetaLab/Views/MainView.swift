import SwiftUI

struct MainView: View {
    @ObservedObject var app: AppModel
    @StateObject private var wallet: WalletModel
    @StateObject private var operation: OperationModel

    init(app: AppModel) {
        self.app = app
        let walletModel = WalletModel(api: app.api, token: { [weak app] in app?.token },
                                      onUnauthenticated: { [weak app] in app?.endSession(message: "Your session has ended. Please sign in again.") })
        _wallet = StateObject(wrappedValue: walletModel)
        _operation = StateObject(wrappedValue: OperationModel(
            api: app.api,
            token: { [weak app] in app?.token },
            onWallet: { [weak walletModel] w in
                walletModel?.apply(w)
                Task { await walletModel?.refresh() } // keep history in sync with the server
            },
            onUnauthenticated: { [weak app] in app?.endSession(message: "Your session has ended. Please sign in again.") }
        ))
    }

    var body: some View {
        TabView {
            WalletView(wallet: wallet, app: app)
                .tabItem { Label("Wallet", systemImage: "creditcard") }
            OperationView(operation: operation, wallet: wallet, app: app)
                .tabItem { Label("Process", systemImage: "wand.and.stars") }
            HistoryView(wallet: wallet)
                .tabItem { Label("History", systemImage: "list.bullet.rectangle") }
            AccountView(app: app)
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .task { await wallet.refresh() }
    }
}

struct AccountView: View {
    @ObservedObject var app: AppModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Signed in as") {
                    Text(app.user?.email ?? "").accessibilityIdentifier("account.email")
                }
                Section {
                    Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
                        .accessibilityIdentifier("account.signOut")
                }
                Section {
                    Text("M1 QA fixture. Purchases use a deterministic mock billing provider: no real payments, StoreKit or ads.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Account")
        }
    }
}
