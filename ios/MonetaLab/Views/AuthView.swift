import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var app: AppModel
    @State private var email = ""
    @State private var password = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("auth.email")
                    SecureField("Password (8–128 characters)", text: $password)
                        .textContentType(.password)
                        .accessibilityIdentifier("auth.password")
                }
                if let error = app.authError {
                    Section {
                        Text(error).foregroundStyle(.red).accessibilityIdentifier("auth.error")
                    }
                }
                Section {
                    Button("Sign In") { Task { await app.signIn(email: email, password: password) } }
                        .accessibilityIdentifier("auth.signIn")
                    Button("Create Account") { Task { await app.register(email: email, password: password) } }
                        .accessibilityIdentifier("auth.register")
                }
                .disabled(app.isWorking || email.isEmpty || password.isEmpty)
                if app.isWorking { ProgressView() }
            }
            .navigationTitle("MonetaLab")
        }
    }
}
