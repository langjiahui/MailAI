import Foundation
@preconcurrency import Network

public enum MailConnectionFailure: String, Error, LocalizedError, Sendable {
    case localNetworkDenied, dns, unavailable, refused, timedOut

    public var errorDescription: String? {
        switch self {
        case .localNetworkDenied:
            return "本地网络访问受限。请在 iPhone 设置 → 隐私与安全性 → 本地网络中允许 MailAI，然后返回重试。"
        case .dns:
            return "无法解析邮箱服务器。公司邮箱请连接公司 Wi-Fi 或指定 VPN，并在高级设置中核对内网服务器地址。"
        case .unavailable:
            return "无法到达邮箱服务器。请连接公司 Wi-Fi 或指定 VPN；仅能上网的移动数据可能无法访问公司内网。"
        case .refused:
            return "邮箱服务器拒绝连接。请在高级设置核对 IMAP／SMTP 地址、端口和加密方式。"
        case .timedOut:
            return "连接邮箱服务器超时。请确认公司 Wi-Fi／VPN 可用、已允许本地网络访问，再手动重试。"
        }
    }
}

/// Recover an initial TCP/TLS connection using Apple's endpoint-aware routing.
/// This allows a first-use local-network prompt to finish instead of treating
/// its initial socket failure as a bad password. No credentials or commands are
/// sent. Do not gate on public Internet reachability or force a Wi-Fi route,
/// which could bypass the user's VPN. SMTP submission is never retried here.
public enum MailConnectionGate {
    // Only pass the connection handshake, never login or SMTP submission. Normal
    // connections incur no extra socket; a first-use permission failure gets one
    // bounded recovery attempt before any credentials or message are sent.
    public static func connect(host: String, port: Int,
        attempt: @Sendable () async throws -> Void,
        reset: @Sendable () async -> Void) async throws {
        try Task.checkCancellation()
        do { try await attempt() }
        catch {
            try Task.checkCancellation()
            await reset()
            try await prepare(host: host, port: port)
            try Task.checkCancellation()
            try await attempt()
        }
    }

    public static func prepare(host: String, port: Int, timeout: TimeInterval = 30) async throws {
        try Task.checkCancellation()
        guard let port = UInt16(exactly: port), port > 0 else {
            throw MailFailure.invalid("端口必须在 1 到 65535 之间。")
        }
        let attempt = ConnectionAttempt(host: host, port: port, timeout: timeout)
        try await withTaskCancellationHandler {
            try await attempt.run()
        } onCancel: { attempt.cancel() }
    }
}

private final class ConnectionAttempt: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.mailai.mail-connect")
    private let connection: NWConnection
    private let timeout: TimeInterval
    // All state, including completion before continuation registration, is
    // serialized on queue. A cancellation can therefore never strand a task.
    private var continuation: CheckedContinuation<Void, Error>?
    private var result: Result<Void, Error>?
    private var lastFailure: MailConnectionFailure = .timedOut
    private var timer: DispatchWorkItem?

    init(host: String, port: UInt16, timeout: TimeInterval) {
        connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        self.timeout = max(0.01, timeout)
    }

    func run() async throws {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                if let result = self.result { continuation.resume(with: result); return }
                self.continuation = continuation
                self.connection.stateUpdateHandler = { [weak self] state in self?.update(state) }
                let timer = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.finish(.failure(self.lastFailure))
                }
                self.timer = timer
                self.queue.asyncAfter(deadline: .now() + self.timeout, execute: timer)
                self.connection.start(queue: self.queue)
            }
        }
    }

    func cancel() { queue.async { self.finish(.failure(CancellationError())) } }

    private func update(_ state: NWConnection.State) {
        switch state {
        case .ready: finish(.success(()))
        case .waiting(let error):
            // Keep waiting while the system permission sheet or route is pending.
            lastFailure = failure(error)
        case .failed(let error): finish(.failure(failure(error)))
        case .cancelled:
            if result == nil { finish(.failure(CancellationError())) }
        default: break
        }
    }

    private func failure(_ error: NWError) -> MailConnectionFailure {
        if connection.currentPath?.unsatisfiedReason == .localNetworkDenied { return .localNetworkDenied }
        switch error {
        case .dns: return .dns
        case .posix(.ECONNREFUSED): return .refused
        case .posix(.ETIMEDOUT): return .timedOut
        default: return .unavailable
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        guard self.result == nil else { return }
        self.result = result
        timer?.cancel(); timer = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        continuation?.resume(with: result); continuation = nil
    }
}
