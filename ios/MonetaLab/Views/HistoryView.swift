import SwiftUI

struct HistoryView: View {
    @ObservedObject var wallet: WalletModel
    @State private var showPurchases = false

    var body: some View {
        NavigationStack {
            List {
                Picker("History", selection: $showPurchases) {
                    Text("Credits").tag(false)
                    Text("Purchases").tag(true)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("history.mode")

                if let error = wallet.errorMessage {
                    Text(error).foregroundStyle(.red)
                }
                if showPurchases {
                    if wallet.purchases.isEmpty {
                        Text("No purchases yet.").foregroundStyle(.secondary).accessibilityIdentifier("history.purchases.empty")
                    }
                    ForEach(wallet.purchases) { p in
                        VStack(alignment: .leading) {
                            Text("\(p.packageId): \(p.outcome)").font(.headline)
                            Text("Granted \(p.creditsGranted.credits) of \(p.credits.credits) credits").font(.footnote)
                            Text(p.createdAt).font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("history.purchase")
                    }
                } else {
                    if wallet.history.isEmpty {
                        Text("No credit activity yet.").foregroundStyle(.secondary).accessibilityIdentifier("history.empty")
                    }
                    ForEach(wallet.history) { entry in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(describe(entry)).font(.headline)
                                Text("\(entry.bucket.capitalized) · \(entry.createdAt)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(entry.delta > 0 ? "+\(entry.delta.credits)" : "\(entry.delta.credits)")
                                .monospacedDigit()
                                .foregroundStyle(entry.delta > 0 ? .green : .primary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("history.entry")
                    }
                }
            }
            .navigationTitle("History")
            .refreshable { await wallet.refresh() }
        }
    }

    private func describe(_ entry: HistoryEntry) -> String {
        switch entry.type {
        case "PURCHASE_GRANT": return "Purchase \(entry.purchase?.packageId ?? "")"
        case "OPERATION_DEBIT": return "Operation \(entry.operation?.action ?? "")"
        case "SEED": return "Test credit (\(entry.seedReason ?? "seed"))"
        default: return entry.type
        }
    }
}
