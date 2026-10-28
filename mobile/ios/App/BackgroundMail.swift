import SwiftUI
import BackgroundTasks
import UserNotifications
import MailAICore

@MainActor final class BackgroundMail {
    static let shared = BackgroundMail()
    static let identifier = "com.mailai.ios.refresh"
    private var work: Task<Void, Never>?
    func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            Task { @MainActor in self.run(refresh) }
        }
    }
    func schedule() {
        guard UserDefaults.standard.bool(forKey: "mail.background") else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(request) }
        catch { UserDefaults.standard.set("系统暂未接受后台刷新请求，可稍后重试。", forKey: "mail.backgroundStatus") }
    }
    func stop() {
        work?.cancel(); work = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.identifier)
    }
    private func run(_ task: BGAppRefreshTask) {
        schedule()
        guard UserDefaults.standard.bool(forKey: "mail.background"), work == nil else { task.setTaskCompleted(success: false); return }
        work = Task {
            var success = false
            do {
                let store = MailStore(vault: KeychainVault(), files: try MailFiles(), service: NativeMailService())
                guard store.error == nil, !store.accounts.isEmpty else { throw MailFailure.missingPassword }
                try await store.refreshAllInboxes(); try Task.checkCancellation()
                let inbox = try store.cachedInbox()
                await notify(inbox)
                UserDefaults.standard.set(Date(), forKey: "mail.backgroundDate")
                UserDefaults.standard.set("后台检查成功", forKey: "mail.backgroundStatus")
                success = true
            } catch {
                UserDefaults.standard.set(Task.isCancelled ? "后台检查被系统取消，保留缓存。" : "后台检查未完成。设备锁定、网络或账号验证可能受限。", forKey: "mail.backgroundStatus")
            }
            task.setTaskCompleted(success: success); work = nil
        }
        task.expirationHandler = { Task { @MainActor in self.work?.cancel() } }
    }
    private func notify(_ messages: [LocatedMessage]) async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        for accountID in Set(messages.map(\.accountID)) {
            let items = messages.filter { $0.accountID == accountID }
            guard let newest = items.max(by: { $0.summary.uid < $1.summary.uid }) else { continue }
            let key = "mail.notificationCursor." + accountID.uuidString
            let old = UserDefaults.standard.dictionary(forKey: key)
            let validity = newest.summary.validity
            let last = old?["uid"] as? Int ?? 0
            let sameValidity = (old?["validity"] as? Int) == Int(validity)
            if sameValidity, settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                for item in items.filter({ $0.summary.uid > last && $0.summary.unread }).prefix(10) {
                    let content = UNMutableNotificationContent()
                    content.title = item.summary.senderName ?? item.summary.sender
                    content.body = item.summary.subject; content.sound = .default
                    let request = UNNotificationRequest(identifier: item.id, content: content, trigger: nil)
                    try? await center.add(request)
                }
            }
            // First observation establishes a baseline, avoiding alerts for historical mail.
            UserDefaults.standard.set(["validity": Int(validity), "uid": Int(newest.summary.uid)], forKey: key)
        }
    }
}
struct BackgroundSettingsView: View {
    @AppStorage("mail.background") private var enabled = false
    @AppStorage("mail.backgroundStatus") private var status = "尚无后台检查记录"
    @State private var permission = "正在读取…"
    var body: some View {
        Form {
            Section {
                Toggle("允许系统调度后台收信", isOn: $enabled)
                    .onChange(of: enabled) { _, value in if value { BackgroundMail.shared.schedule() } else { BackgroundMail.shared.stop(); status = "后台收信已关闭" } }
                Text("iOS 决定运行时机，不能保证固定间隔或即时提醒。锁屏时钥匙串可能不可用，打开应用后仍会同步。不提供 APNs 服务端推送。").font(.footnote).foregroundStyle(.secondary)
            }
            Section("通知") {
                LabeledContent("系统通知权限", value: permission)
                Button("申请通知权限") { Task { do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]); await readPermission() } catch { permission = "申请未完成" } } }
                Text("仅在后台检查发现新邮件且系统允许通知时提醒。首次检查建立基线，不批量提醒历史邮件。").font(.footnote).foregroundStyle(.secondary)
            }
            Section("最近后台结果") {
                Text(status)
                if let date = UserDefaults.standard.object(forKey: "mail.backgroundDate") as? Date { Text(date.formatted()).font(.caption).foregroundStyle(.secondary) }
                Button("重新提交调度请求") { BackgroundMail.shared.schedule() }.disabled(!enabled)
            }
        }.navigationTitle("后台收信与通知").task { await readPermission() }
    }
    private func readPermission() async {
        let value = await UNUserNotificationCenter.current().notificationSettings()
        switch value.authorizationStatus { case .authorized, .provisional, .ephemeral: permission = "已允许"; case .denied: permission = "已关闭，可在系统设置开启"; default: permission = "尚未申请" }
    }
}
