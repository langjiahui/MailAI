import SwiftUI
import Observation
import BackgroundTasks
import UserNotifications
import MailAICore

@MainActor @Observable final class BackgroundMail: NSObject, UNUserNotificationCenterDelegate {
    static let shared = BackgroundMail()
    static let identifier = "com.mailai.ios.refresh"
    static let backgroundService = "com.mailai.ios.background-accounts.v1"
    var pendingTarget: MailNotificationTarget?
    var pendingSettings = false
    var refreshID = UUID()
    var checking = false
    private var work: Task<Void, Never>?
    private var foreground: Task<Void, Never>?
    private let defaults: UserDefaults
    private let center: UNUserNotificationCenter
    private var fixture: Bool {
        #if DEBUG
        return CommandLine.arguments.contains("--ui-fixture")
        #else
        return false
        #endif
    }
    init(defaults: UserDefaults = .standard, center: UNUserNotificationCenter = .current()) { self.defaults = defaults; self.center = center; super.init() }
    private var vault: KeychainVault { KeychainVault(service: Self.backgroundService + (fixture ? ".ui-tests" : ""), backgroundAccess: true) }
    private func file() throws -> MailNotificationFile {
        if fixture { return try MailNotificationFile(root: FileManager.default.temporaryDirectory.appendingPathComponent("MailAI-Notification-UI")) }
        return try MailNotificationFile()
    }
    private var service: any MailService {
        #if DEBUG
        if fixture { return DebugPreview.notificationService }
        #endif
        return NativeMailService()
    }
    func register() {
        center.delegate = self
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            Task { @MainActor in self.run(refresh) }
        }
    }
    /// Copy only account credentials after the user enables background mail.
    /// Foreground credentials, message caches, attachments and model keys retain
    /// their original while-unlocked protection and are never migrated here.
    func synchronizeAccounts() throws {
        guard defaults.bool(forKey: "mail.background") else { try vault.remove(); return }
        let entries: [AccountCredential]
        #if DEBUG
        if fixture { entries = DebugPreview.notificationCredentials }
        else { entries = try KeychainVault().load() }
        #else
        entries = try KeychainVault().load()
        #endif
        let existing = try vault.load()
        if existing.count != entries.count || !zip(existing, entries).allSatisfy({ $0.account == $1.account && $0.password == $1.password }) { try vault.save(entries) }
        let file = try file(); var ledger = try file.load()
        ledger.retainAccounts(Set(entries.map { $0.account.id })); try file.save(ledger)
        if entries.isEmpty { center.removeAllPendingNotificationRequests(); center.removeAllDeliveredNotifications() }
    }
    func activate() {
        cancelRunning(); foreground?.cancel()
        guard defaults.bool(forKey: "mail.background") else { return }
        do { try synchronizeAccounts() } catch { defaults.set("后台收信凭据尚未准备好，请解锁后重试。", forKey: "mail.checkStatus"); return }
        schedule()
        foreground = Task {
            await checkNow()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)); try Task.checkCancellation() } catch { return }
                await checkNow()
            }
        }
    }
    func enterBackground() {
        foreground?.cancel(); foreground = nil
        do { try synchronizeAccounts() } catch { defaults.set("后台凭据准备失败，请打开应用后重试。", forKey: "mail.checkStatus") }
        schedule()
    }
    func schedule() {
        guard defaults.bool(forKey: "mail.background"), !fixture else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(request); defaults.set("已提交系统调度，运行时间由 iOS 决定。", forKey: "mail.scheduleStatus") }
        catch { defaults.set("系统暂未接受请求，请检查系统后台 App 刷新和低电量模式。", forKey: "mail.scheduleStatus") }
    }
    func cancelRunning() { work?.cancel() }
    func stop() {
        foreground?.cancel(); foreground = nil; work?.cancel(); work = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.identifier)
        do { try vault.remove(); try file().remove() } catch { defaults.set("后台数据清理未完成，请解锁后重试。", forKey: "mail.checkStatus") }
        center.removeAllPendingNotificationRequests(); center.removeAllDeliveredNotifications()
        defaults.set("后台收信已关闭", forKey: "mail.scheduleStatus")
    }
    func enable() async -> Bool {
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined { _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge]); settings = await center.notificationSettings() }
        guard Self.permitted(settings.authorizationStatus) else { return false }
        do { try synchronizeAccounts(); activate(); return true }
        catch { defaults.set("后台凭据准备失败，请解锁后重试。", forKey: "mail.checkStatus"); return false }
    }
    static func permitted(_ status: UNAuthorizationStatus) -> Bool { status == .authorized || status == .provisional || status == .ephemeral }
    private func performCheck() async throws -> MailNotificationCheck.Result {
        guard defaults.bool(forKey: "mail.background"), !checking else { throw MailFailure.invalid("后台收信未开启，或已有检查正在进行。") }
        checking = true; defer { checking = false }
        let entries = try vault.load()
        guard !entries.isEmpty else { throw MailFailure.missingPassword }
        let settings = await center.notificationSettings()
        return try await MailNotificationCheck.run(credentials: entries, service: service, file: file(), permitted: Self.permitted(settings.authorizationStatus), preview: defaults.bool(forKey: "mail.notificationPreview")) { [weak self] batch in
            try Task.checkCancellation(); guard let self, self.defaults.bool(forKey: "mail.background") else { throw CancellationError() }
            guard let newest = batch.max(by: { $0.target.uid < $1.target.uid }) else { return }
            let content = UNMutableNotificationContent()
            content.title = batch.count == 1 ? String((newest.sender ?? "MailAI 新邮件").prefix(80)) : "MailAI 新邮件"
            content.body = batch.count == 1 ? String((newest.subject ?? "你收到了一封新邮件，点按查看。").prefix(280)) : "收到 \(batch.count) 封新邮件，点按查看最新一封。"
            content.sound = .default
            content.threadIdentifier = newest.target.accountID.uuidString
            content.categoryIdentifier = "mailai.mail"
            content.userInfo = ["mailai.type": "mail", "account": newest.target.accountID.uuidString, "uid": String(newest.target.uid), "validity": String(newest.target.validity)]
            try await self.center.add(UNNotificationRequest(identifier: newest.target.identifier, content: content, trigger: nil))
        }
    }
    func checkNow() async {
        guard defaults.bool(forKey: "mail.background"), !checking else { return }
        do {
            try synchronizeAccounts()
            let result = try await performCheck(); try Task.checkCancellation()
            defaults.set(Self.description(result), forKey: "mail.checkStatus"); defaults.set(Date(), forKey: "mail.checkDate")
            if result.submittedMessages > 0 { refreshID = UUID() }
        } catch { defaults.set(Task.isCancelled ? "检查已取消，未确认完成。" : "检查未完成，请检查邮箱连接或重新开启提醒。", forKey: "mail.checkStatus") }
    }
    private static func description(_ result: MailNotificationCheck.Result) -> String {
        if result.failedAccounts > 0 { return "\(result.checkedAccounts) 个邮箱检查完成，\(result.failedAccounts) 个连接失败；已保留未送达提醒。" }
        if result.deliveryFailures > 0 { return "收信检查完成，提醒提交失败，稍后重试。" }
        return result.submittedMessages > 0 ? "检查完成，已向系统提交 \(result.submittedMessages) 封新邮件提醒。" : "检查完成，暂无需要提醒的新邮件。首次检查仅建立基线。"
    }
    private func run(_ task: BGAppRefreshTask) {
        schedule()
        guard defaults.bool(forKey: "mail.background"), !checking, work == nil else { task.setTaskCompleted(success: false); return }
        work = Task {
            var success = false
            do {
                let result = try await performCheck(); try Task.checkCancellation()
                success = result.failedAccounts == 0 && result.deliveryFailures == 0
                defaults.set(Self.description(result), forKey: "mail.backgroundStatus")
                if success { defaults.set(Date(), forKey: "mail.backgroundDate") }
            } catch { defaults.set(Task.isCancelled ? "后台检查被系统取消，稍后再试。" : "后台检查未完成：设备需先解锁一次，或邮箱网络暂不可用。", forKey: "mail.backgroundStatus") }
            task.setTaskCompleted(success: success); work = nil
        }
        task.expirationHandler = { Task { @MainActor in self.work?.cancel() } }
    }
    func hidePreviews() {
        do { let file = try file(); var ledger = try file.load(); ledger.hidePreviews(); try file.save(ledger) } catch {}
        center.removeAllDeliveredNotifications()
    }
    func testNotification() async -> String {
        let settings = await center.notificationSettings()
        guard Self.permitted(settings.authorizationStatus) else { return "请先允许系统通知。" }
        let content = UNMutableNotificationContent(); content.title = "MailAI 测试提醒"; content.body = "通知通道正常。这不是新邮件；点按返回通知设置。"; content.sound = .default; content.categoryIdentifier = "mailai.test"; content.userInfo = ["mailai.type": "test"]
        do { try await center.add(UNNotificationRequest(identifier: "mailai.notification.test", content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 10, repeats: false))); return "已提交测试提醒，请在 10 秒内切到后台或锁屏查看。提交成功不代表已显示。" }
        catch { return "测试提醒提交失败，请检查系统通知设置。" }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .sound, .list]) }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let test = info["mailai.type"] as? String == "test"
        let target: MailNotificationTarget? = {
            guard info["mailai.type"] as? String == "mail", let text = info["account"] as? String, let account = UUID(uuidString: text), let textUID = info["uid"] as? String, let uid = UInt32(textUID), uid > 0, let textValidity = info["validity"] as? String, let validity = UInt32(textValidity), validity > 0 else { return nil }
            return MailNotificationTarget(accountID: account, uid: uid, validity: validity)
        }()
        Task { @MainActor in if test { self.pendingSettings = true }; if let target { self.pendingTarget = target }; completionHandler() }
    }
}

struct BackgroundSettingsView: View {
    @AppStorage("mail.background") private var enabled = false
    @AppStorage("mail.notificationPreview") private var preview = false
    @AppStorage("mail.backgroundStatus") private var backgroundStatus = "尚无系统后台检查记录"
    @AppStorage("mail.scheduleStatus") private var scheduleStatus = "尚未提交系统调度"
    @AppStorage("mail.checkStatus") private var checkStatus = "尚未检查"
    @State private var permission = "正在读取…"
    @State private var permissionDenied = false
    @State private var background = "正在读取…"
    @State private var lowPower = false
    @State private var testStatus: String?
    @State private var enabling = false
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        Form {
            Section {
                Toggle("后台收信与提醒", isOn: $enabled).disabled(enabling).accessibilityIdentifier("background-mail-toggle")
                    .onChange(of: enabled) { _, value in
                        if value { enabling = true; Task { if !(await BackgroundMail.shared.enable()) { enabled = false; BackgroundMail.shared.stop() }; enabling = false; await readPermission() } }
                        else { BackgroundMail.shared.stop() }
                    }
                Text("由 iOS 择机检查，可能延迟，不是即时推送。").font(.footnote).foregroundStyle(.secondary)
                DisclosureGroup("锁屏与后台说明") { Text("开启后，为后台收信单独保存必要的邮箱凭据与提醒状态。重启后需先解锁一次；正文、附件、草稿仍保留原有锁屏保护。系统关闭后台 App 刷新、低电量模式、公司网络或 VPN 不可达都可能影响收信。强制退出应用后请重新打开。").font(.footnote).foregroundStyle(.secondary) }
            }.listRowBackground(MailTheme.surface)
            Section("系统状态") {
                LabeledContent("通知权限", value: permission)
                LabeledContent("后台 App 刷新", value: background)
                LabeledContent("低电量模式", value: lowPower ? "已开启，可能推迟检查" : "未开启")
                if permissionDenied { Button("打开系统通知设置", systemImage: "arrow.up.right.square") { settings() } }
                Button("申请通知权限") { Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]); await readPermission() } }
                Toggle("提醒中显示发件人和主题", isOn: $preview).onChange(of: preview) { _, value in if !value { BackgroundMail.shared.hidePreviews() } }
                Text("默认只提示有新邮件；锁屏展示还受系统通知预览和专注模式控制。").font(.footnote).foregroundStyle(.secondary)
            }.listRowBackground(MailTheme.surface)
            Section("检查与测试") {
                Button("立即检查新邮件") { Task { await BackgroundMail.shared.checkNow() } }.disabled(!enabled || BackgroundMail.shared.checking).accessibilityIdentifier("notification-check-now")
                if BackgroundMail.shared.checking { ProgressView("正在检查…") }
                Text(checkStatus).font(.footnote)
                Button("10 秒后发送测试提醒") { Task { testStatus = await BackgroundMail.shared.testNotification() } }.accessibilityIdentifier("notification-test")
                if let testStatus { Text(testStatus).font(.footnote).foregroundStyle(MailTheme.secondary) }
                Text("测试提醒仅验证系统通知展示，不代表真实邮件已收到或后台调度已运行。").font(.footnote).foregroundStyle(.secondary)
            }.listRowBackground(MailTheme.surface)
            Section("系统后台检查") {
                Text(scheduleStatus).font(.footnote)
                Text(backgroundStatus).font(.footnote)
                if let date = UserDefaults.standard.object(forKey: "mail.backgroundDate") as? Date { Text("最近成功：" + date.formatted()).font(.caption).foregroundStyle(.secondary) }
                Button("重新提交调度请求") { BackgroundMail.shared.schedule() }.disabled(!enabled)
            }.listRowBackground(MailTheme.surface)
        }.scrollContentBackground(.hidden).background(MailTheme.canvas).navigationTitle("后台收信与通知").navigationBarTitleDisplayMode(.inline).toolbar(.hidden, for: .tabBar)
            .task { await readPermission() }.onChange(of: scenePhase) { _, phase in if phase == .active { Task { await readPermission() } } }
    }
    private func settings() { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
    private func readPermission() async {
        let value = await UNUserNotificationCenter.current().notificationSettings()
        permissionDenied = value.authorizationStatus == .denied
        switch value.authorizationStatus { case .authorized: permission = "已允许"; case .provisional: permission = "安静送达"; case .ephemeral: permission = "临时允许"; case .denied: permission = "已关闭"; default: permission = "尚未申请" }
        switch UIApplication.shared.backgroundRefreshStatus { case .available: background = "可用，由系统调度"; case .denied: background = "已关闭，请在系统设置开启"; default: background = "受系统限制" }
        lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    }
}
