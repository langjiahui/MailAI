import XCTest
@preconcurrency import Network
@testable import MailAICore

final class IntranetConnectionTests: XCTestCase {
    private actor Attempts {
        var connections = 0
        var resets = 0
        func next() -> Int { connections += 1; return connections }
        func reset() { resets += 1 }
        func counts() -> [Int] { [connections, resets] }
    }
    func testUserConfiguredMailAcceptsPrivateIPv4CGNATAndIPv6ULA() throws {
        for host in ["10.42.0.8", "172.16.1.2", "192.168.8.9", "100.64.1.2", "fd12::8", "fc00::1", "2001:db8::8", "imap.corp.example", "mailhost"] {
            XCTAssertNoThrow(try MailValidation.validateHost(host), host)
        }
        for host in ["0.0.0.0", "0.1.2.3", "127.0.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "febf::1", "ff02::1", "::ffff:10.1.2.3", "10.999.1.1", "10.1.1", "mail:993", "imap..corp", "mail/host", "user@mail", "mail\r\n", "[fd12::8]", "-mail.corp", "mail_.corp"] {
            XCTAssertThrowsError(try MailValidation.validateHost(host), host)
        }
    }

    func testReadyConnectionSendsNoCredentialsOrMailCommands() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "Synthetic TCP listener")
        let empty = expectation(description: "Probe closes without sending data")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { data, _, _, _ in
                XCTAssertTrue(data == nil || data!.isEmpty, "A pre-login probe must never transmit credentials or commands")
                connection.cancel(); empty.fulfill()
            }
        }
        listener.start(queue: .global())
        defer { listener.cancel() }
        await fulfillment(of: [ready], timeout: 5)
        let attempts = Attempts()
        try await MailConnectionGate.connect(host: "127.0.0.1", port: Int(try XCTUnwrap(listener.port).rawValue),
            attempt: {
                if await attempts.next() == 1 { throw MailConnectionFailure.unavailable }
            }, reset: { await attempts.reset() })
        await fulfillment(of: [empty], timeout: 5)
        let counts = await attempts.counts(); XCTAssertEqual(counts, [2, 1])
    }

    func testSuccessfulHandshakeDoesNotProbeOrOpenAnotherSocket() async throws {
        let attempts = Attempts()
        // An unresolvable host would fail if the gate tried opening a probe on
        // the success path. Only recovery should do so.
        try await MailConnectionGate.connect(host: "no-such-mail.invalid", port: 993,
            attempt: { _ = await attempts.next() }, reset: { await attempts.reset() })
        let counts = await attempts.counts(); XCTAssertEqual(counts, [1, 0])
    }

    func testRefusedPortIsNotReportedAsAPasswordFailure() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = expectation(description: "Reserve test port")
        let stopped = expectation(description: "Release test port")
        listener.newConnectionHandler = { $0.cancel() }
        listener.stateUpdateHandler = {
            if case .ready = $0 { ready.fulfill() }
            if case .cancelled = $0 { stopped.fulfill() }
        }
        listener.start(queue: .global())
        await fulfillment(of: [ready], timeout: 5)
        let port = Int(try XCTUnwrap(listener.port).rawValue)
        listener.cancel()
        await fulfillment(of: [stopped], timeout: 5)
        do {
            try await MailConnectionGate.prepare(host: "127.0.0.1", port: port, timeout: 1)
            XCTFail("Closed port must fail")
        } catch { XCTAssertEqual(error as? MailConnectionFailure, .refused) }
    }

    func testCancellationAndInvalidPortNeverStartLogin() async throws {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await MailConnectionGate.prepare(host: "127.0.0.1", port: 9)
        }
        do { try await task.value; XCTFail("Cancelled operation must stop") }
        catch { XCTAssertTrue(error is CancellationError) }
        for port in [-1, 0, 65536] {
            do { try await MailConnectionGate.prepare(host: "127.0.0.1", port: port); XCTFail("Invalid port") }
            catch { XCTAssertNotNil(error as? MailFailure) }
        }
    }

    func testNetworkMessagesAreActionableWithoutExposingServerOrCredentials() {
        XCTAssertTrue(MailConnectionFailure.localNetworkDenied.localizedDescription.contains("本地网络"))
        XCTAssertTrue(MailConnectionFailure.dns.localizedDescription.contains("解析"))
        XCTAssertTrue(MailConnectionFailure.unavailable.localizedDescription.contains("VPN"))
        XCTAssertTrue(MailConnectionFailure.refused.localizedDescription.contains("端口"))
    }
}
