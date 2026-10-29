import XCTest

final class LaunchTests: XCTestCase {
    private func declineSystemPasswordSave(_ app: XCUIApplication) {
        // iOS may offer Passwords storage when a filled login form disappears,
        // including cancellation. Never save the synthetic test credential.
        let saveSheet = app.sheets["Save Password?"]
        if saveSheet.waitForExistence(timeout: 3) {
            attach("system-password-save-offer")
            let notNow = saveSheet.buttons["Not Now"]
            XCTAssertTrue(notNow.waitForExistence(timeout: 3))
            notNow.tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: saveSheet)
            waitForExpectations(timeout: 5)
        }
    }
    private func openAccountForm(_ app: XCUIApplication) {
        app.launch()
        XCTAssertTrue(app.buttons["add-account"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts["操作提示"].exists, "Startup must not hide a Keychain failure")
        let add = app.buttons["add-account"]
        XCTAssertTrue(add.isHittable, "First-run add button must be tappable")
        add.tap()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 10))
    }
    func testOnboardingAndAccountForm() {
        let app = XCUIApplication(); openAccountForm(app)
        XCTAssertTrue(app.secureTextFields["password"].exists)
        XCTAssertFalse(app.textFields["imap-host"].exists)
        XCTAssertFalse(app.textFields["smtp-host"].exists)
        XCTAssertFalse(app.textFields["login-username"].exists)
        XCTAssertFalse(app.buttons["validate-account"].isEnabled)
        attach("account-simple-empty")
        app.textFields["email"].tap(); app.textFields["email"].typeText("demo@qq.com")
        XCTAssertTrue(app.staticTexts["provider-status"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["provider-status"].label.contains("QQ"))
        app.secureTextFields["password"].tap()
        app.secureTextFields["password"].typeText("synthetic-never-submitted")
        XCTAssertTrue(app.buttons["validate-account"].isEnabled)
        XCTAssertFalse(app.staticTexts["正在验证并添加…"].exists)
        attach("account-simple-qq")
        app.buttons["取消"].firstMatch.tap()
        let formDismissed = NSPredicate(format: "exists == false")
        expectation(for: formDismissed, evaluatedWith: app.textFields["email"])
        waitForExpectations(timeout: 10)
        declineSystemPasswordSave(app)
        let add = app.buttons["add-account"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        attach("account-welcome-after-cancel")
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: add)
        waitForExpectations(timeout: 10)
        add.tap()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textFields["email"].value as? String, "邮箱地址")
        XCTAssertFalse(app.buttons["validate-account"].isEnabled)
        // Repeat with an active keyboard; no input or stale sheet may survive cancellation.
        for _ in 0..<2 {
            app.textFields["email"].tap()
            app.textFields["email"].typeText("repeat@example.com")
            app.buttons["取消"].firstMatch.tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.textFields["email"])
            waitForExpectations(timeout: 10)
            declineSystemPasswordSave(app)
            expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: add)
            waitForExpectations(timeout: 10)
            add.tap()
            XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 10))
            XCTAssertEqual(app.textFields["email"].value as? String, "邮箱地址")
        }
    }
    func testUnknownDomainPrefillsDefaultsInsideOptionalSettings() {
        let app = XCUIApplication(); openAccountForm(app)
        app.textFields["email"].tap(); app.textFields["email"].typeText("demo@corp.example")
        XCTAssertTrue(app.staticTexts["provider-status"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["provider-status"].label.contains("默认"))
        XCTAssertFalse(app.textFields["imap-host"].exists)
        app.swipeUp()
        app.buttons["高级设置（可选）"].tap()
        let host = app.textFields["imap-host"]
        XCTAssertTrue(host.waitForExistence(timeout: 3))
        XCTAssertEqual(host.value as? String, "imap.corp.example")
        XCTAssertEqual(app.textFields["login-username"].value as? String, "demo@corp.example")
        app.swipeUp()
        XCTAssertEqual(app.textFields["smtp-host"].value as? String, "smtp.corp.example")
        attach("account-domain-defaults")
        // No Validate tap: no credentials leave the simulator.
    }
    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 0.5)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

final class WorkspaceTests: XCTestCase {
    private func launch(dark: Bool = false, large: Bool = false, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture"] + extra
        if dark { app.launchArguments.append("--ui-dark") }
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", large ? "UICTContentSizeCategoryAccessibilityXXXL" : "UICTContentSizeCategoryL"]
        app.launch(); XCTAssertTrue(app.buttons["compose-mail"].waitForExistence(timeout: 10)); return app
    }
    private func openSection(_ title: String, in app: XCUIApplication) {
        let avatar = app.buttons["account-avatar"]
        for _ in 0..<8 {
            if avatar.exists && avatar.isHittable { break }
            let back = app.navigationBars.buttons.element(boundBy: 0)
            XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
        }
        XCTAssertTrue(avatar.waitForExistence(timeout: 5)); avatar.tap()
        let entry = app.buttons[title == "通讯录" ? "sidebar-contacts" : "sidebar-settings"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5)); entry.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
    }
    private func assertMinimumTargetHeight(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        // A 3x display can report a 44 pt frame as 43.99999999999999.
        // Normalize floating-point geometry without changing the 44 pt target.
        let height = (element.frame.height * 1000).rounded() / 1000
        XCTAssertGreaterThanOrEqual(height, 44, file: file, line: line)
    }
    func testInboxControlsScrollAwayAndToolbarActionsStayReachable() {
        let app = launch(extra: ["--ui-long-inbox"])
        let header = app.buttons["inbox-search-header"], toolbarSearch = app.buttons["inbox-search-toolbar"]
        let navigation = app.navigationBars.firstMatch, compose = app.buttons["compose-mail"]
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertTrue(header.isHittable); XCTAssertTrue(toolbarSearch.isHittable)
        XCTAssertLessThanOrEqual(compose.frame.maxY, navigation.frame.maxY + 2)
        assertMinimumTargetHeight(compose)
        attach("reading-space-inbox-light")
        app.swipeUp(); app.swipeUp()
        XCTAssertFalse(header.exists && header.isHittable, "Search/filter header must scroll with the mail list")
        XCTAssertTrue(toolbarSearch.isHittable); XCTAssertTrue(compose.isHittable)
        attach("reading-space-inbox-scrolled")
        toolbarSearch.tap()
        XCTAssertTrue(app.textFields["mail-search-input"].waitForExistence(timeout: 5))
        app.buttons["完成"].firstMatch.tap()
        for _ in 0..<6 { if header.exists && header.isHittable { break }; app.swipeDown() }
        XCTAssertTrue(header.isHittable)
        app.buttons["inbox-filter"].tap(); app.buttons["未读"].firstMatch.tap()
        XCTAssertTrue(app.buttons["clear-inbox-filter"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["项目资料确认与下一步安排"].exists)
        XCTAssertFalse(app.staticTexts["移动端设计评审"].exists)
        XCTAssertTrue((app.buttons["更多邮件操作"].value as? String)?.contains("未读") == true)
        attach("reading-space-unread-filter")
        app.buttons["clear-inbox-filter"].tap()
        XCTAssertTrue(app.staticTexts["移动端设计评审"].waitForExistence(timeout: 5))
        app.buttons["inbox-filter"].tap(); app.buttons["附件"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["合同修订版本"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["移动端设计评审"].exists)
        app.buttons["clear-inbox-filter"].tap()
    }
    func testSidebarDestinationsReturnToTheSameMailboxAndFilter() {
        let app = launch()
        app.buttons["inbox-filter"].tap(); app.buttons["星标"].firstMatch.tap()
        app.buttons["account-avatar"].tap()
        XCTAssertTrue(app.buttons["sidebar-contacts"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["sidebar-settings"].isHittable)
        attach("reading-space-sidebar-tools")
        app.buttons["sidebar-contacts"].tap()
        XCTAssertTrue(app.navigationBars["通讯录"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        app.buttons["contact-team@example.com"].tap()
        XCTAssertTrue(app.buttons["编辑"].waitForExistence(timeout: 5))
        openSection("设置", in: app)
        XCTAssertTrue(app.buttons["appearance-settings"].isHittable)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["account-avatar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["移动端设计评审"].exists)
        XCTAssertFalse(app.staticTexts["项目资料确认与下一步安排"].exists)
        XCTAssertTrue((app.buttons["更多邮件操作"].value as? String)?.contains("星标") == true)
        app.buttons["clear-inbox-filter"].tap()
    }
    func testMailboxReadingReplyAndComposer() {
        let app = launch()
        let message = app.staticTexts["项目资料确认与下一步安排"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5)); attach("blue-inbox-light")
        message.tap()
        XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.tabBars.firstMatch.exists, "Reading must hide the top-level tabs")
        XCTAssertTrue(app.staticTexts["附件（1）"].exists || app.buttons["附件（1）"].exists)
        app.buttons["邮件详细信息"].tap(); attach("redesign-reader-address-details")
        attach("blue-reader-light")
        app.buttons["回复全部"].tap()
        let to = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        let cc = app.descendants(matching: .any).matching(identifier: "compose-cc").firstMatch
        XCTAssertTrue(to.waitForExistence(timeout: 5))
        XCTAssertTrue((to.value as? String)?.contains("sender@example.com") == true)
        XCTAssertTrue((cc.value as? String)?.contains("team@example.com") == true)
        attach("blue-compose-light")
        app.swipeUp(); XCTAssertTrue(app.buttons["添加附件"].waitForExistence(timeout: 5))
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
    }
    func testContactsAndSettingsInDarkMode() {
        let app = launch(dark: true)
        openSection("通讯录", in: app)
        XCTAssertTrue(app.staticTexts["项目组"].waitForExistence(timeout: 5)); attach("blue-contacts-dark")
        XCTAssertTrue(app.staticTexts["测试联系人"].exists, "Names from cached mail must appear in contacts")
        openSection("设置", in: app); attach("redesign-settings-home-dark")
        app.buttons["appearance-settings"].tap()
        let theme = app.descendants(matching: .any).matching(identifier: "theme-setting").firstMatch
        XCTAssertTrue(theme.waitForExistence(timeout: 5)); XCTAssertEqual(theme.value as? String, "宝武蓝 · 蓝白"); attach("blue-settings-dark")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5))
        attach("refinement-model-key-only-dark")
    }
    func testModelSetupOnlyNeedsKeyForASelectedCloudProvider() {
        let app = launch(extra: ["--ui-model-setup"])
        openSection("设置", in: app); app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["model-endpoint"].exists)
        XCTAssertFalse(app.textFields["model-name"].exists)
        app.secureTextFields["API Key"].tap(); app.secureTextFields["API Key"].typeText("synthetic-not-networked\n")
        attach("refinement-model-key-only")
        app.buttons["model-provider"].tap(); app.buttons["Kimi（月之暗面）"].tap()
        XCTAssertEqual(app.secureTextFields["API Key"].value as? String, "API Key")
        app.buttons["高级设置（可选）"].tap()
        XCTAssertEqual(app.textFields["model-endpoint"].value as? String, "https://api.moonshot.cn/v1")
        XCTAssertEqual(app.textFields["model-name"].value as? String, "kimi-k2.6")
        attach("refinement-model-preset-advanced")
    }
    func testCompactHeaderOnlyInboxKeepsIconActionsAndReadingReachable() {
        let app = launch(extra: ["--ui-header-only"])
        let compose = app.buttons["compose-mail"], avatar = app.buttons["account-avatar"]
        XCTAssertEqual(compose.label, "写邮件")
        XCTAssertLessThanOrEqual(compose.frame.width, 50); assertMinimumTargetHeight(compose)
        XCTAssertTrue(avatar.isHittable); XCTAssertLessThanOrEqual(avatar.frame.width, 50)
        XCTAssertTrue(app.staticTexts["版本计划确认"].isHittable, "Six header-only messages should fit without excess row whitespace")
        attach("refinement-inbox-dense-light")
        avatar.tap(); XCTAssertTrue(app.buttons["完成"].waitForExistence(timeout: 5)); app.buttons["完成"].tap()
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
    }
    func testRecipientSelectionRequiresDoneAndPersistsDraft() {
        let app = launch()
        app.buttons["compose-mail"].tap()
        app.buttons["选择收件人"].tap()
        let contactSearch = app.textFields["mail-search-input"]
        XCTAssertTrue(contactSearch.waitForExistence(timeout: 5)); contactSearch.tap(); contactSearch.typeText("team")
        XCTAssertTrue(app.buttons["取消"].firstMatch.isHittable)
        XCTAssertTrue(app.buttons["recipient-team@example.com"].waitForExistence(timeout: 5))
        app.buttons["recipient-team@example.com"].tap()
        app.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(app.buttons["send-mail"].exists)
        XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        app.buttons["选择收件人"].tap()
        XCTAssertTrue(app.buttons["recipient-team@example.com"].waitForExistence(timeout: 5))
        app.buttons["recipient-team@example.com"].tap()
        attach("redesign-recipient-picker-selected")
        app.buttons["完成（1）"].tap()
        let recipient = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertTrue((recipient.value as? String)?.contains("team@example.com") == true)
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        app.buttons["更多邮件操作"].tap(); app.buttons["草稿与发送记录"].tap()
        XCTAssertTrue(app.staticTexts["team@example.com"].waitForExistence(timeout: 5))
        attach("redesign-draft-recipients")
    }
    func testCopyRecipientPickerKeepsItsTargetOnFirstOpen() {
        let app = launch()
        app.buttons["compose-mail"].tap()
        let to = app.textFields["compose-to-input"]
        to.tap(); to.typeText("recipient@example.com\n")
        app.buttons["抄送 / 密送"].tap(); app.buttons["选择抄送"].tap()
        XCTAssertTrue(app.buttons["recipient-team@example.com"].waitForExistence(timeout: 5))
        app.buttons["recipient-team@example.com"].tap(); app.buttons["完成（1）"].tap()
        let cc = app.descendants(matching: .any).matching(identifier: "compose-cc").firstMatch
        let recipients = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertEqual(cc.value as? String, "team@example.com")
        XCTAssertEqual(recipients.value as? String, "recipient@example.com")
        attach("redesign-cc-recipient-target")
    }
    func testValidationFailureKeepsFormAndCanBeCancelled() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture", "--ui-empty-accounts", "--ui-account-failure"]
        app.launch(); app.buttons["add-account"].tap()
        app.textFields["email"].tap(); app.textFields["email"].typeText("audit@example.com")
        app.secureTextFields["password"].tap(); app.secureTextFields["password"].typeText("synthetic-never-networked")
        app.swipeUp(); app.buttons["validate-account"].tap()
        XCTAssertTrue(app.buttons["取消验证"].waitForExistence(timeout: 2)); attach("redesign-account-validation-progress")
        app.buttons["取消验证"].tap()
        XCTAssertTrue(app.buttons["validate-account"].isEnabled)
        app.buttons["validate-account"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "account-error").firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(app.textFields["email"].value as? String, "audit@example.com"); attach("redesign-account-validation-failure")
    }
    func testReadFailurePreservesBackNavigation() {
        let app = launch(extra: ["--ui-read-failure"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        XCTAssertTrue(app.buttons["重试"].waitForExistence(timeout: 5)); attach("redesign-read-failure")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["compose-mail"].waitForExistence(timeout: 5))
    }
    func testUnknownSendAndPendingCopyRemainDistinct() {
        let app = launch(extra: ["--ui-records"])
        app.buttons["更多邮件操作"].tap(); app.buttons["草稿与发送记录"].tap()
        XCTAssertTrue(app.staticTexts["合成待办草稿"].waitForExistence(timeout: 5)); attach("redesign-drafts-list")
        app.segmentedControls.buttons["发送记录"].tap(); attach("redesign-send-records")
        app.buttons.containing(.staticText, identifier: "合成待确认记录").firstMatch.tap()
        XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        app.swipeUp()
        XCTAssertTrue(app.buttons["已确认未送达，继续编辑"].waitForExistence(timeout: 5)); attach("redesign-unknown-send")
        app.buttons["已确认未送达，继续编辑"].tap()
        XCTAssertTrue(app.buttons["保留记录"].waitForExistence(timeout: 5)); attach("redesign-unlock-send-confirmation")
        app.buttons["保留记录"].tap()
        XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        app.buttons.containing(.staticText, identifier: "合成副本待存档").firstMatch.tap(); app.swipeUp()
        XCTAssertTrue(app.buttons["重试保存副本"].waitForExistence(timeout: 5)); attach("redesign-pending-sent-copy")
        XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        app.buttons["重试保存副本"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["重试保存副本"])
        waitForExpectations(timeout: 5)
    }
    func testAssistantRequiresScopeAndSummaryCannotBeAdoptedAsReply() {
        let app = launch(extra: ["--ui-assistant"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        app.buttons["小邮助手"].tap()
        app.buttons["提炼要点"].tap()
        XCTAssertTrue(app.buttons["开始处理"].waitForExistence(timeout: 5)); attach("redesign-ai-scope-confirmation")
        app.buttons["开始处理"].tap()
        XCTAssertTrue(app.staticTexts["synthetic model response"].waitForExistence(timeout: 10)); attach("redesign-ai-summary-result")
        XCTAssertFalse(app.buttons["创建回复草稿"].exists)
        app.buttons["查看原文对照"].tap(); attach("redesign-ai-original-comparison")
        app.buttons["起草回复"].tap(); app.buttons["开始处理"].tap()
        XCTAssertTrue(app.buttons["创建回复草稿"].waitForExistence(timeout: 10))
        app.buttons["创建回复草稿"].tap()
        XCTAssertTrue(app.buttons["send-mail"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textViews["compose-body-editor"].value as? String, "synthetic model response")
        attach("redesign-ai-editable-reply")
    }
    func testNativePickersKeepUnsentDraftIntact() {
        let app = launch()
        app.buttons["compose-mail"].tap()
        let body = app.textViews["compose-body-editor"]
        body.tap(); body.typeText("Synthetic unsent draft")
        app.buttons["收起键盘"].tap()
        app.buttons["添加附件"].tap(); attach("redesign-attachment-source-menu")
        app.buttons["选择文件"].tap(); cancelSystemPicker(app, screenshot: "redesign-system-files")
        assertEventuallyHittable(body)
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        app.buttons["照片"].tap(); cancelSystemPicker(app, screenshot: "redesign-system-photos", photoLibrary: true)
        assertEventuallyHittable(body)
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        app.buttons["添加附件"].tap(); app.buttons["从照片选择"].tap()
        cancelSystemPicker(app, screenshot: "reading-space-photos-from-menu", photoLibrary: true)
        assertEventuallyHittable(body)
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        app.buttons["选择收件人"].tap(); app.buttons["从手机联系人选择"].tap()
        cancelSystemPicker(app, screenshot: "redesign-system-contacts", contactPicker: true)
        assertEventuallyHittable(app.buttons["从手机联系人选择"])
        app.buttons["取消"].firstMatch.tap()
        assertEventuallyHittable(body)
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
    }
    private func dialogCancel(_ app: XCUIApplication) -> XCUIElement {
        let english = app.buttons["Cancel"].firstMatch
        return english.waitForExistence(timeout: 2) ? english : app.buttons["取消"].firstMatch
    }
    private func assertEventuallyHittable(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in element.exists && element.isHittable }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, file: file, line: line)
        XCTAssertTrue(element.isHittable, file: file, line: line)
    }
    private func cancelSystemPicker(_ app: XCUIApplication, screenshot: String, photoLibrary: Bool = false, contactPicker: Bool = false) {
        let labels = ["Cancel", "取消", "Close", "关闭"]
        var cancellationButtons = app.buttons
        if photoLibrary {
            let titles = ["Photos", "照片"]
            let navigation = app.navigationBars.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", titles, titles)).firstMatch
            // The loading controller has its own cancel button. Wait for the
            // remote photo library before querying hittability or taking proof.
            XCTAssertTrue(navigation.segmentedControls.firstMatch.waitForExistence(timeout: 30), "Photo library must finish loading before cancellation is tested")
            cancellationButtons = navigation.buttons
        } else if contactPicker {
            // iOS 26 exposes the native picker's X as Close, while the parent
            // recipient sheet still has a Cancel button behind the picker.
            let titles = ["Contacts", "联系人", "通讯录"]
            let navigation = app.navigationBars.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", titles, titles)).firstMatch
            guard navigation.waitForExistence(timeout: 30) else {
                attach(screenshot)
                XCTFail("Native contacts navigation must finish loading before cancellation is tested")
                return
            }
            cancellationButtons = navigation.buttons
        }
        let candidates = cancellationButtons.matching(NSPredicate(format: "identifier IN %@ OR label IN %@", labels, labels))
        // Scope photos to the loaded library so its temporary loading controller
        // cannot invalidate a cancel element while XCTest resolves hittability.
        func currentCancel() -> XCUIElement? { candidates.allElementsBoundByIndex.last { $0.isHittable } }
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in currentCancel() != nil }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        attach(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = screenshot + "-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        guard let cancel = currentCancel() else { XCTFail("Native picker must offer cancellation"); return }
        XCTAssertTrue(cancel.isHittable); cancel.tap()
    }
    func testMailboxFiltersSelectionAndMovePicker() {
        let app = launch()
        app.buttons["inbox-filter"].tap(); app.buttons["星标"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["移动端设计评审"].waitForExistence(timeout: 5)); attach("redesign-flagged-filter")
        XCTAssertFalse(app.staticTexts["项目资料确认与下一步安排"].exists)
        app.buttons["clear-inbox-filter"].tap()
        app.buttons["更多邮件操作"].tap(); attach("redesign-inbox-menu")
        app.buttons["选择邮件"].tap()
        app.buttons["选择邮件"].firstMatch.tap()
        XCTAssertFalse(app.tabBars.firstMatch.exists); attach("redesign-bulk-selection")
        app.buttons["移动"].tap()
        XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["移动 1 封邮件"].exists)
        let currentFolder = app.buttons.containing(.staticText, identifier: "当前位置").firstMatch
        XCTAssertTrue(currentFolder.exists); XCTAssertFalse(currentFolder.isEnabled)
        attach("redesign-move-picker")
        app.buttons["取消"].tap(); app.buttons["完成"].firstMatch.tap()
        app.buttons["邮箱与文件夹"].tap()
        XCTAssertTrue(app.buttons["所有收件箱"].waitForExistence(timeout: 5)); attach("redesign-mailboxes")
        app.buttons["所有收件箱"].tap()
        XCTAssertTrue(app.staticTexts["项目资料确认与下一步安排"].waitForExistence(timeout: 5)); attach("redesign-unified-inbox")
    }
    func testHTMLModeAndExternalLinkConfirmation() {
        let app = launch(extra: ["--ui-html"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        let link = app.webViews.links["测试外部链接"]
        XCTAssertTrue(link.waitForExistence(timeout: 10)); attach("redesign-html-reader")
        link.tap()
        XCTAssertTrue(app.buttons["打开链接"].waitForExistence(timeout: 5)); attach("redesign-external-link-confirmation")
        dialogCancel(app).tap()
        app.buttons["更多邮件操作"].tap(); app.buttons["查看纯文本"].tap()
        XCTAssertFalse(app.webViews.firstMatch.exists); attach("redesign-plain-reader")
    }
    func testConversationExpandsActualMessages() {
        let app = launch(extra: ["--ui-threads"])
        app.buttons["更多邮件操作"].tap(); app.buttons["按会话显示"].tap()
        app.buttons.matching(NSPredicate(format: "label CONTAINS '2 封' AND label CONTAINS '未读'")).firstMatch.tap()
        let reply = app.staticTexts["Re: 项目资料确认与下一步安排"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5)); attach("redesign-conversation-list")
        app.buttons["thread-message-8"].tap()
        let older = app.buttons["展开会话邮件：测试联系人"]
        XCTAssertTrue(older.waitForExistence(timeout: 5)); attach("redesign-conversation-reader")
        older.tap()
        XCTAssertTrue(app.buttons["展开会话邮件：设计团队"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["回复全部"].exists)
    }
    func testAttachmentPreviewAndNativeShare() {
        let app = launch(extra: ["--ui-pdf"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        app.staticTexts["合成项目方案.pdf"].tap()
        // Quick Look first exposes its share button on an empty loading view.
        // Wait for the actual PDF before interacting with that remote toolbar.
        let document = app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "仅用于 MailAI 界面验收")).firstMatch
        XCTAssertTrue(document.waitForExistence(timeout: 30))
        let englishShare = app.buttons["Share"].firstMatch
        let share = englishShare.waitForExistence(timeout: 5) ? englishShare : (app.buttons["共享"].firstMatch.exists ? app.buttons["共享"].firstMatch : app.buttons["分享"].firstMatch)
        XCTAssertTrue(share.waitForExistence(timeout: 5)); assertEventuallyHittable(share); attach("redesign-quicklook-pdf")
        share.tap()
        let copyAction = app.cells.matching(NSPredicate(format: "label IN %@", ["Copy", "拷贝", "复制"])).firstMatch
        XCTAssertTrue(copyAction.waitForExistence(timeout: 15)); XCTAssertTrue(copyAction.isHittable)
        XCTAssertTrue(app.cells.matching(NSPredicate(format: "label IN %@", ["Save to Files", "存储到文件", "保存到文件"])).firstMatch.waitForExistence(timeout: 15))
        attach("redesign-system-share")
    }
    func testAttachmentCancellationAndFailureKeepBody() {
        var app = launch(extra: ["--ui-attachment-slow"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        app.staticTexts["测试说明.txt"].tap()
        XCTAssertTrue(app.buttons["取消下载"].waitForExistence(timeout: 3)); attach("redesign-attachment-progress")
        app.buttons["取消下载"].tap()
        XCTAssertTrue(app.buttons["回复全部"].exists)
        app.terminate()
        app = launch(extra: ["--ui-attachment-failure"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap(); app.staticTexts["测试说明.txt"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '合成附件下载失败'")).firstMatch.waitForExistence(timeout: 5)); attach("redesign-attachment-failure")
        XCTAssertTrue(app.buttons["回复全部"].exists)
    }
    func testNativeNotificationPermissionIsUserTriggered() {
        let app = launch()
        openSection("设置", in: app); app.buttons["后台收信与通知"].tap()
        app.buttons["申请通知权限"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5)); attach("redesign-system-notification-permission")
        let deny = alert.buttons["Don’t Allow"].exists ? alert.buttons["Don’t Allow"] : (alert.buttons["Don't Allow"].exists ? alert.buttons["Don't Allow"] : alert.buttons["不允许"])
        XCTAssertTrue(deny.exists); deny.tap()
    }
    func testDraftAttachmentsFormatAndDecisionDialogs() {
        let app = launch(extra: ["--ui-records"])
        app.buttons["更多邮件操作"].tap(); app.buttons["草稿与发送记录"].tap()
        app.buttons.containing(.staticText, identifier: "合成待办草稿").firstMatch.tap()
        XCTAssertTrue(app.buttons["移除附件 合成附件.txt"].waitForExistence(timeout: 5)); attach("redesign-composer-attachment")
        app.buttons["移除附件 合成附件.txt"].tap()
        XCTAssertFalse(app.staticTexts["合成附件.txt"].exists)
        app.buttons["文字格式"].tap(); attach("redesign-format-menu"); app.buttons["加粗"].tap()
        app.textViews["compose-body-editor"].typeText("Bold "); attach("redesign-formatted-composer")
        app.buttons["收起键盘"].tap()
        app.buttons["send-mail"].tap()
        XCTAssertTrue(app.buttons["确认发送"].waitForExistence(timeout: 5)); attach("redesign-send-confirmation")
        app.buttons["取消"].firstMatch.tap()
        app.buttons["关闭"].tap(); attach("redesign-exit-draft-confirmation")
        app.buttons["继续编辑"].tap()
        XCTAssertTrue(app.buttons["send-mail"].exists)
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        app.cells.containing(.staticText, identifier: "合成待办草稿").firstMatch.swipeLeft()
        app.buttons["删除"].firstMatch.tap()
        XCTAssertTrue(app.buttons["删除草稿"].waitForExistence(timeout: 5)); attach("redesign-delete-draft-confirmation")
        app.buttons["Cancel"].firstMatch.exists ? app.buttons["Cancel"].firstMatch.tap() : app.buttons["取消"].firstMatch.tap()
    }
    func testContactMenusDetailAndEditingKeepAccountScope() {
        let app = launch()
        openSection("通讯录", in: app)
        app.buttons["联系人操作"].tap(); attach("redesign-contact-add-menu")
        app.buttons["新建联系人"].tap()
        XCTAssertFalse(app.buttons["保存"].isEnabled)
        app.textFields["contact-email"].tap(); app.textFields["contact-email"].typeText("audit@example.com")
        XCTAssertTrue(app.buttons["保存"].isEnabled); attach("redesign-new-contact")
        app.buttons["取消"].firstMatch.tap()
        XCTAssertFalse(app.staticTexts["audit@example.com"].exists)
        app.buttons["contact-team@example.com"].tap()
        XCTAssertTrue(app.buttons["编辑"].waitForExistence(timeout: 5)); attach("redesign-contact-detail")
        app.buttons["编辑"].tap()
        XCTAssertEqual(app.textFields["contact-email"].value as? String, "team@example.com"); attach("redesign-contact-editor")
        app.buttons["取消"].firstMatch.tap()
        app.buttons["写邮件"].tap()
        let to = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertTrue((to.value as? String)?.contains("team@example.com") == true)
    }
    func testReadFlagUndoAndLongPressMenu() {
        let app = launch()
        let cell = app.cells.containing(.staticText, identifier: "项目资料确认与下一步安排").firstMatch
        cell.swipeRight(); attach("redesign-mail-swipe-actions")
        app.buttons["已读"].firstMatch.tap()
        XCTAssertTrue(app.buttons["撤销"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["撤销"].frame.intersects(app.buttons["compose-mail"].frame))
        attach("redesign-mail-undo")
        app.buttons["撤销"].tap()
        app.cells.containing(.staticText, identifier: "项目资料确认与下一步安排").firstMatch.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["标为已读"].waitForExistence(timeout: 5)); attach("redesign-mail-context-menu")
    }
    func testForwardDoesNotCarryAnyOriginalRecipient() {
        let app = launch()
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        app.buttons["转发"].tap(); attach("redesign-forward-source-menu")
        app.buttons["转发正文"].tap()
        XCTAssertTrue(app.buttons["send-mail"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        let to = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertEqual(to.value as? String, "")
        app.buttons["抄送 / 密送"].tap()
        for field in ["compose-cc", "compose-bcc"] { XCTAssertEqual(app.descendants(matching: .any).matching(identifier: field).firstMatch.value as? String, "") }
        attach("redesign-forward-empty-recipients")
    }
    func testDraftSaveFailureKeepsInputAndBlocksExit() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture", "--ui-save-failure"]; app.launch()
        let body = app.textViews["compose-body-editor"]
        XCTAssertTrue(body.waitForExistence(timeout: 5)); body.tap(); body.typeText("Unsaved synthetic text")
        app.buttons["收起键盘"].tap(); app.swipeUp()
        XCTAssertTrue(app.buttons["重试保存"].waitForExistence(timeout: 5)); attach("redesign-draft-save-failure")
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        XCTAssertTrue(app.buttons["关闭"].exists)
        XCTAssertEqual(body.value as? String, "Unsaved synthetic text")
    }
    func testSubmissionDisablesControlsUntilServerResult() {
        let app = launch(extra: ["--ui-records", "--ui-send-slow"])
        app.buttons["更多邮件操作"].tap(); app.buttons["草稿与发送记录"].tap()
        app.buttons.containing(.staticText, identifier: "合成待办草稿").firstMatch.tap()
        app.buttons["send-mail"].tap(); app.buttons["确认发送"].tap()
        XCTAssertFalse(app.buttons["关闭"].isEnabled); XCTAssertFalse(app.buttons["send-mail"].exists && app.buttons["send-mail"].isEnabled)
        app.swipeUp(); attach("redesign-submitting")
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["send-mail"])
        waitForExpectations(timeout: 20)
        XCTAssertTrue((app.textViews["compose-body-editor"].value as? String)?.contains("用于设计验收") == true)
    }
    func testAssistantFailureAndCancellationNeverExposePartialResult() {
        var app = launch(extra: ["--ui-assistant", "--ui-ai-failure"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap(); app.buttons["小邮助手"].tap()
        app.buttons["起草回复"].tap(); app.buttons["开始处理"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '未返回完整文字'")).firstMatch.waitForExistence(timeout: 10)); attach("redesign-ai-failure")
        XCTAssertFalse(app.buttons["创建回复草稿"].exists)
        app.terminate()
        app = launch(extra: ["--ui-assistant", "--ui-ai-slow"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap(); app.buttons["小邮助手"].tap()
        app.buttons["起草回复"].tap(); app.buttons["开始处理"].tap()
        XCTAssertTrue(app.buttons["取消"].firstMatch.waitForExistence(timeout: 3)); attach("redesign-ai-processing")
        app.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["已取消，结果未采用。"].waitForExistence(timeout: 5)); attach("redesign-ai-cancelled")
        let late = expectation(for: NSPredicate(format: "exists == true"), evaluatedWith: app.staticTexts["synthetic model response"])
        late.isInverted = true; waitForExpectations(timeout: 6)
        XCTAssertFalse(app.buttons["创建回复草稿"].exists)
    }
    func testPageTourInDarkAndAccessibilitySizes() {
        for (dark, large, variant) in [(true, false, "dark"), (true, true, "dark-large"), (false, true, "light-large")] {
            let app = launch(dark: dark, large: large, extra: ["--ui-assistant"])
            if large { XCTAssertLessThan(app.buttons["inbox-filter"].frame.height, 100) }; XCTAssertFalse(app.tabBars.firstMatch.exists)
            attach("tour-" + variant + "-inbox")
            app.buttons["邮箱与文件夹"].tap(); attach("tour-" + variant + "-mailboxes")
            app.buttons["完成"].firstMatch.tap()
            app.buttons["搜索邮件"].tap()
            XCTAssertTrue(app.textFields["mail-search-input"].waitForExistence(timeout: 5)); attach("tour-" + variant + "-search")
            app.buttons["完成"].firstMatch.tap()
            app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
            XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
            if large { XCTAssertLessThan(app.buttons["回复全部"].frame.height, 80); XCTAssertTrue(app.buttons["回复全部"].isHittable) }
            attach("tour-" + variant + "-reader")
            app.buttons["小邮助手"].tap(); attach("tour-" + variant + "-assistant")
            app.buttons["提炼要点"].tap()
            XCTAssertTrue(app.buttons["开始处理"].waitForExistence(timeout: 5)); attach("tour-" + variant + "-scope")
            app.buttons["取消"].firstMatch.tap(); app.buttons["完成"].firstMatch.tap()
            app.buttons["回复全部"].tap(); attach("tour-" + variant + "-composer")
            app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
            openSection("通讯录", in: app); attach("tour-" + variant + "-contacts")
            app.buttons["contact-team@example.com"].tap(); attach("tour-" + variant + "-contact-detail")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            openSection("设置", in: app); attach("tour-" + variant + "-settings")
            app.buttons.containing(.staticText, identifier: "测试邮箱").firstMatch.tap()
            XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "account-protocol").firstMatch.waitForExistence(timeout: 5))
            XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "account-protocol").firstMatch.value as? String, "IMAP"); attach("tour-" + variant + "-account-detail")
            app.swipeUp(); attach("tour-" + variant + "-account-detail-preferences")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.buttons["appearance-settings"].tap(); attach("tour-" + variant + "-appearance")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.buttons["小邮与模型服务"].tap(); attach("tour-" + variant + "-model-settings")
            app.buttons["model-provider"].tap(); app.buttons["DeepSeek"].tap()
            XCTAssertFalse(app.textFields["model-endpoint"].exists)
            attach("refinement-" + variant + "-model-key-only")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.swipeUp(); app.buttons["后台收信与通知"].tap(); attach("tour-" + variant + "-background")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.swipeUp(); app.buttons["关于 MailAI"].tap(); attach("tour-" + variant + "-about")
            app.swipeUp(); app.buttons["隐私与数据"].tap(); attach("tour-" + variant + "-privacy")
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.buttons["开源许可"].tap()
            XCTAssertTrue(app.buttons["license-0"].waitForExistence(timeout: 5)); attach("tour-" + variant + "-licenses")
            app.buttons["license-0"].tap()
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Apache'")).firstMatch.waitForExistence(timeout: 5)); attach("tour-" + variant + "-license-text")
            app.navigationBars.buttons.element(boundBy: 0).tap(); app.navigationBars.buttons.element(boundBy: 0).tap(); app.navigationBars.buttons.element(boundBy: 0).tap()
            app.swipeDown(); app.swipeDown(); app.buttons["添加邮箱"].tap()
            XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 5)); attach("tour-" + variant + "-account")
            app.swipeUp(); app.buttons["高级设置（可选）"].tap(); attach("tour-" + variant + "-advanced-account")
            app.terminate()
        }
    }
    func testPolishingKeepsQuotedMailAndCanRestoreDraft() {
        let app = launch(extra: ["--ui-assistant"])
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap(); app.buttons["回复全部"].tap()
        let body = app.textViews["compose-body-editor"]
        XCTAssertTrue(body.waitForExistence(timeout: 5)); body.tap(); body.typeText("Synthetic current draft")
        app.buttons["收起键盘"].tap(); app.buttons["小邮润色"].tap(); app.buttons["润色"].tap()
        XCTAssertTrue(app.staticTexts["Synthetic current draft"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["assistant-scope-text"].label, "Synthetic current draft")
        XCTAssertFalse(app.staticTexts["assistant-scope-text"].label.contains("请于周五前确认测试材料"))
        app.buttons["开始处理"].tap()
        XCTAssertTrue(app.buttons["采用到正文"].waitForExistence(timeout: 10)); app.buttons["采用到正文"].tap()
        XCTAssertEqual(body.value as? String, "synthetic model response")
        app.swipeUp(); app.buttons["原邮件 · 点击展开"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '请于周五前确认测试材料'")).firstMatch.waitForExistence(timeout: 5))
        attach("redesign-polish-retains-original-mail")
        app.swipeUp(); app.buttons["撤回润色"].tap()
        XCTAssertEqual(body.value as? String, "Synthetic current draft")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '请于周五前确认测试材料'")).firstMatch.exists)
    }
    func testEmptyInboxOfflineAndServerSearchSource() {
        var app = launch(extra: ["--ui-empty-inbox"])
        XCTAssertTrue(app.staticTexts["暂无邮件"].waitForExistence(timeout: 5)); attach("redesign-empty-inbox")
        XCTAssertTrue(app.buttons["compose-mail"].isHittable)
        app.terminate()
        app = launch(extra: ["--ui-offline"])
        XCTAssertTrue(app.buttons["关闭状态提示"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["项目资料确认与下一步安排"].exists); attach("redesign-offline-cache")
        app.buttons["关闭状态提示"].tap(); app.terminate()
        app = launch(extra: ["--ui-server-search"])
        app.buttons["搜索邮件"].tap()
        let search = app.textFields["mail-search-input"]
        search.tap(); search.typeText("sender")
        app.buttons["搜索服务器整个当前文件夹"].tap()
        XCTAssertTrue(app.staticTexts["服务器匹配 1 封 · 已显示 1 封"].waitForExistence(timeout: 5)); attach("redesign-server-search-results")
        XCTAssertFalse(app.staticTexts["本机缓存匹配"].exists)
        search.tap(); search.typeText("-no-match")
        XCTAssertTrue(app.staticTexts["没有匹配的邮件"].waitForExistence(timeout: 5)); attach("redesign-search-no-results")
    }
    func testUnconfiguredAssistantDoesNotOfferUploadActions() {
        let app = launch()
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap(); app.buttons["小邮助手"].tap()
        XCTAssertTrue(app.buttons["配置小邮与模型服务"].waitForExistence(timeout: 5)); attach("redesign-ai-unconfigured")
        XCTAssertFalse(app.buttons["提炼要点"].exists); XCTAssertFalse(app.buttons["开始处理"].exists)
    }
    func testStorageFailureOffersRetryWithoutDeletingData() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture", "--ui-storage-error"]; app.launch()
        XCTAssertTrue(app.buttons["重试"].waitForExistence(timeout: 5)); attach("redesign-storage-error")
        app.buttons["重试"].tap()
        XCTAssertTrue(app.buttons["compose-mail"].waitForExistence(timeout: 5))
    }
    func testSecondarySettingsAndConfirmationSurfaces() {
        let app = launch()
        openSection("设置", in: app)
        app.buttons.containing(.staticText, identifier: "测试邮箱").firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "account-protocol").firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "account-protocol").firstMatch.value as? String, "IMAP"); attach("redesign-account-detail")
        app.buttons.matching(NSPredicate(format: "label CONTAINS '收信服务器'")).firstMatch.tap()
        XCTAssertTrue(app.textFields["imap-host"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["imap-host"].value as? String, "imap.example.com"); attach("redesign-edit-server-settings")
        app.navigationBars.buttons.element(boundBy: 0).tap(); app.buttons["取消"].firstMatch.tap()
        app.buttons["修改密码 / 授权码"].tap()
        XCTAssertTrue(app.secureTextFields["password"].waitForExistence(timeout: 5)); attach("redesign-edit-account")
        app.swipeUp(); attach("redesign-edit-account-preferences")
        XCTAssertTrue(app.switches["保存已发送副本"].exists)
        app.buttons["取消"].firstMatch.tap()
        app.swipeUp()
        XCTAssertTrue(app.buttons["移除此邮箱"].waitForExistence(timeout: 5)); app.buttons["移除此邮箱"].tap()
        let cancelRemoval = dialogCancel(app)
        XCTAssertTrue(cancelRemoval.waitForExistence(timeout: 5)); attach("redesign-remove-account-confirmation")
        cancelRemoval.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5)); attach("redesign-model-settings")
        app.swipeUp(); app.buttons["清除模型配置"].tap()
        let cancelClear = dialogCancel(app)
        XCTAssertTrue(cancelClear.waitForExistence(timeout: 5)); attach("redesign-clear-model-confirmation")
        cancelClear.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["后台收信与通知"].tap()
        XCTAssertTrue(app.buttons["申请通知权限"].waitForExistence(timeout: 5)); attach("redesign-background-settings")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["关于 MailAI"].tap(); attach("redesign-about")
        app.buttons["隐私与数据"].tap()
        XCTAssertTrue(app.staticTexts["保存在你的设备"].waitForExistence(timeout: 5)); attach("redesign-privacy")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["开源许可"].tap()
        XCTAssertTrue(app.buttons["license-0"].waitForExistence(timeout: 5)); attach("redesign-licenses")
        app.buttons["license-0"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Apache'")).firstMatch.waitForExistence(timeout: 5)); attach("redesign-license-text")
    }
    func testSearchFailureKeepsLocalResultsAndRecentQuery() {
        let app = launch()
        app.buttons["搜索邮件"].tap()
        let search = app.textFields["mail-search-input"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("sender")
        XCTAssertTrue(app.staticTexts["项目资料确认与下一步安排"].waitForExistence(timeout: 5)); attach("redesign-local-search")
        app.swipeUp()
        app.buttons["搜索服务器整个当前文件夹"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '服务器搜索失败'")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["项目资料确认与下一步安排"].exists); attach("redesign-search-failure-cache")
        app.buttons["完成"].firstMatch.tap()
        app.buttons["搜索邮件"].tap()
        XCTAssertTrue(app.buttons["清空最近搜索"].waitForExistence(timeout: 5)); attach("redesign-recent-search")
    }
    func testLargeTextKeepsComposeAndNavigationReachable() {
        let app = launch(dark: true, large: true)
        XCTAssertTrue(app.buttons["compose-mail"].isHittable)
        app.buttons["compose-mail"].tap()
        XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["send-mail"].exists)
        attach("blue-compose-accessibility-dark")
        let body = app.textViews["compose-body-editor"]
        for _ in 0..<4 { if body.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(body.waitForExistence(timeout: 5)); XCTAssertTrue(body.isHittable); body.tap(); body.typeText("Synthetic accessibility draft")
        XCTAssertTrue(app.buttons["添加附件"].isHittable)
        XCTAssertTrue(app.buttons["收起键盘"].isHittable)
        attach("redesign-compose-accessibility-keyboard")
        app.buttons["收起键盘"].tap()
        XCTAssertTrue(app.buttons["关闭"].isHittable)
    }
    private func attach(_ name: String) {
        Thread.sleep(forTimeInterval: 0.5)
        let value = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); value.name = name; value.lifetime = .keepAlways; add(value)
    }
}
