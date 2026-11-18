import SwiftUI

/// PRD §3.1 paywall with Subscription | Credits tabs.
struct PaywallView: View {
    @StateObject var model: PaywallModel
    let catalog: Catalog
    var title: String
    var subtitle: String?
    /// Called after every purchase attempt with the wallet returned by the server.
    let onWalletChanged: (Wallet) -> Void
    let onClose: () -> Void

    init(model: PaywallModel, catalog: Catalog, title: String, subtitle: String? = nil,
         onWalletChanged: @escaping (Wallet) -> Void, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: model)
        self.catalog = catalog
        self.title = title
        self.subtitle = subtitle
        self.onWalletChanged = onWalletChanged
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            List {
                if let subtitle {
                    Section { Text(subtitle).accessibilityIdentifier("paywall.required") }
                }
                Section {
                    Picker("Plan type", selection: $model.tab) {
                        ForEach(PaywallModel.Tab.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("paywall.tab")
                }
                switch model.tab {
                case .subscription: subscriptionTab
                case .credits: creditsTab
                }
                Section {
                    // M2 feature: shown, but not available in M1.
                    Button(catalog.rewardedAd.label) {}
                        .disabled(true)
                        .accessibilityIdentifier("paywall.watchAd")
                    Text(catalog.rewardedAd.availability).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onClose).accessibilityIdentifier("paywall.close")
                }
            }
        }
        .interactiveDismissDisabled(model.isPurchasing)
    }

    private var subscriptionTab: some View {
        Section {
            ForEach(catalog.subscriptions) { plan in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(plan.name) Weekly").font(.headline)
                    Text("\(plan.creditsPerPeriod.credits) credits per week")
                    if let offer = plan.introductoryOffer {
                        Text(offer.description).font(.footnote)
                    }
                    Text(plan.availability).font(.footnote).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("paywall.subscription.\(plan.id)")
            }
            Button("Continue") {}
                .disabled(true)
                .accessibilityIdentifier("paywall.subscriptionContinue")
        } footer: {
            Text("Preview only. Subscriptions arrive in a later milestone. Prices are not shown.")
        }
    }

    private var creditsTab: some View {
        Group {
            Section("Credit packs") {
                ForEach(catalog.consumables) { pack in
                    Button {
                        model.selectedPackageId = pack.id
                    } label: {
                        HStack {
                            Text(pack.name)
                            Spacer()
                            Text("\(pack.credits.credits) credits")
                            if model.selectedPackageId == pack.id { Image(systemName: "checkmark") }
                        }
                    }
                    .disabled(model.isPurchasing)
                    .accessibilityIdentifier("paywall.package.\(pack.id)")
                }
            }
            Section {
                Picker("Mock outcome", selection: $model.mockOutcome) {
                    ForEach(MockOutcome.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(model.isPurchasing)
                .accessibilityIdentifier("paywall.outcome")
            } header: {
                Text("Mock billing outcome (test only)")
            } footer: {
                Text("M1 uses a deterministic mock provider. No real payment is made.")
            }
            Section {
                Button(model.isPurchasing ? "Processing…" : "Continue") {
                    Task {
                        if let wallet = await model.continueTapped() { onWalletChanged(wallet) }
                    }
                }
                .disabled(model.selectedPackageId == nil || model.isPurchasing)
                .accessibilityIdentifier("paywall.continue")
                // Result feedback directly under the action the user just took.
                if let message = model.message {
                    Text(message).accessibilityIdentifier("paywall.message")
                }
            }
        }
    }
}
