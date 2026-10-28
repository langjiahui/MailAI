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
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

final class WorkspaceTests: XCTestCase {
    private func launch(dark: Bool = false, large: Bool = false, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture"] + extra
        if dark { app.launchArguments.append("--ui-dark") }
        if large { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch(); XCTAssertTrue(app.buttons["compose-mail"].waitForExistence(timeout: 10)); return app
    }
    func testMailboxReadingReplyAndComposer() {
        let app = launch()
        let message = app.staticTexts["项目资料确认与下一步安排"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5)); attach("blue-inbox-light")
        message.tap()
        XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
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
        app.tabBars.buttons["通讯录"].tap()
        XCTAssertTrue(app.staticTexts["项目组"].waitForExistence(timeout: 5)); attach("blue-contacts-dark")
        app.tabBars.buttons["设置"].tap(); attach("redesign-settings-home-dark")
        app.buttons["appearance-settings"].tap()
        let theme = app.descendants(matching: .any).matching(identifier: "theme-setting").firstMatch
        XCTAssertTrue(theme.waitForExistence(timeout: 5)); XCTAssertEqual(theme.value as? String, "宝武蓝 · 蓝白"); attach("blue-settings-dark")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5))
    }
    func testRecipientSelectionRequiresDoneAndPersistsDraft() {
        let app = launch()
        app.buttons["compose-mail"].tap()
        app.buttons["选择收件人"].tap()
        app.buttons.containing(.staticText, identifier: "协作联系人").firstMatch.tap()
        app.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(app.buttons["send-mail"].exists)
        XCTAssertFalse(app.buttons["send-mail"].isEnabled)
        app.buttons["选择收件人"].tap()
        app.buttons.containing(.staticText, identifier: "协作联系人").firstMatch.tap()
        app.buttons["完成（1）"].tap()
        let recipient = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertTrue((recipient.value as? String)?.contains("team@example.com") == true)
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        app.buttons["更多邮件操作"].tap(); app.buttons["草稿与发送记录"].tap()
        XCTAssertTrue(app.staticTexts["team@example.com"].waitForExistence(timeout: 5))
        attach("redesign-draft-recipients")
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
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "account-error").firstMatch.waitForExistence(timeout: 5))
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
        XCTAssertFalse(app.buttons["send-mail"].isEnabled)
        app.swipeUp()
        XCTAssertTrue(app.buttons["已确认未送达，继续编辑"].waitForExistence(timeout: 5)); attach("redesign-unknown-send")
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        app.buttons.containing(.staticText, identifier: "合成副本待存档").firstMatch.tap(); app.swipeUp()
        XCTAssertTrue(app.buttons["重试保存副本"].waitForExistence(timeout: 5)); attach("redesign-pending-sent-copy")
        XCTAssertFalse(app.buttons["send-mail"].isEnabled)
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
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        app.buttons["照片"].tap(); cancelSystemPicker(app, screenshot: "redesign-system-photos")
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        app.buttons["选择收件人"].tap(); app.buttons["从手机联系人选择"].tap()
        cancelSystemPicker(app, screenshot: "redesign-system-contacts")
        app.buttons["取消"].firstMatch.tap()
        XCTAssertEqual(body.value as? String, "Synthetic unsent draft")
        XCTAssertFalse(app.buttons["send-mail"].isEnabled)
    }
    private func cancelSystemPicker(_ app: XCUIApplication, screenshot: String) {
        let english = app.buttons["Cancel"].firstMatch
        let cancel = english.waitForExistence(timeout: 5) ? english : app.buttons["取消"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5)); XCTAssertTrue(cancel.isHittable)
        attach(screenshot); cancel.tap()
    }
    func testMailboxFiltersSelectionAndMovePicker() {
        let app = launch()
        app.buttons["星标"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["移动端设计评审"].waitForExistence(timeout: 5)); attach("redesign-flagged-filter")
        XCTAssertFalse(app.staticTexts["项目资料确认与下一步安排"].exists)
        app.buttons["全部"].firstMatch.tap()
        app.buttons["更多邮件操作"].tap(); attach("redesign-inbox-menu")
        app.buttons["选择邮件"].tap()
        app.buttons["选择邮件"].firstMatch.tap()
        XCTAssertFalse(app.tabBars.firstMatch.exists); attach("redesign-bulk-selection")
        app.buttons["移动"].tap()
        XCTAssertTrue(app.buttons["取消"].waitForExistence(timeout: 5)); attach("redesign-move-picker")
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
        let cancel = app.buttons["Cancel"].firstMatch.exists ? app.buttons["Cancel"].firstMatch : app.buttons["取消"].firstMatch
        cancel.tap()
        app.buttons["更多邮件操作"].tap(); app.buttons["查看纯文本"].tap()
        XCTAssertFalse(app.webViews.firstMatch.exists); attach("redesign-plain-reader")
    }
    func testConversationExpandsActualMessages() {
        let app = launch(extra: ["--ui-threads"])
        app.buttons["更多邮件操作"].tap(); app.buttons["按会话显示"].tap()
        app.buttons.containing(.staticText, identifier: "项目资料确认与下一步安排").firstMatch.tap()
        let reply = app.staticTexts["Re: 项目资料确认与下一步安排"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 5)); attach("redesign-conversation-list")
        reply.tap()
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
        let englishShare = app.buttons["Share"].firstMatch
        let share = englishShare.waitForExistence(timeout: 5) ? englishShare : (app.buttons["共享"].firstMatch.exists ? app.buttons["共享"].firstMatch : app.buttons["分享"].firstMatch)
        XCTAssertTrue(share.waitForExistence(timeout: 5)); attach("redesign-quicklook-pdf")
        share.tap(); attach("redesign-system-share")
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
        app.tabBars.buttons["设置"].tap(); app.buttons["后台收信与通知"].tap()
        app.buttons["申请通知权限"].tap()
        let alert = app.alerts.firstMatch
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
        app.buttons["删除"].firstMatch.tap(); attach("redesign-delete-draft-confirmation")
        app.buttons["Cancel"].firstMatch.exists ? app.buttons["Cancel"].firstMatch.tap() : app.buttons["取消"].firstMatch.tap()
    }
    func testContactMenusDetailAndEditingKeepAccountScope() {
        let app = launch()
        app.tabBars.buttons["通讯录"].tap()
        app.buttons["联系人操作"].tap(); attach("redesign-contact-add-menu")
        app.buttons["新建联系人"].tap()
        XCTAssertFalse(app.buttons["保存"].isEnabled)
        app.textFields["contact-email"].tap(); app.textFields["contact-email"].typeText("audit@example.com")
        XCTAssertTrue(app.buttons["保存"].isEnabled); attach("redesign-new-contact")
        app.buttons["取消"].firstMatch.tap()
        XCTAssertFalse(app.staticTexts["audit@example.com"].exists)
        app.cells.containing(.staticText, identifier: "协作联系人").firstMatch.tap()
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
        XCTAssertTrue(app.buttons["撤销"].waitForExistence(timeout: 5)); attach("redesign-mail-undo")
        app.buttons["撤销"].tap()
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["标为已读"].waitForExistence(timeout: 5)); attach("redesign-mail-context-menu")
    }
    func testForwardDoesNotCarryAnyOriginalRecipient() {
        let app = launch()
        app.staticTexts["项目资料确认与下一步安排"].firstMatch.tap()
        app.buttons["转发"].tap(); attach("redesign-forward-source-menu")
        app.buttons["转发正文"].tap()
        XCTAssertTrue(app.buttons["send-mail"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["send-mail"].isEnabled)
        let to = app.descendants(matching: .any).matching(identifier: "compose-to").firstMatch
        XCTAssertEqual(to.value as? String, "")
        app.buttons["抄送 / 密送"].tap()
        for field in ["compose-cc", "compose-bcc"] { XCTAssertEqual(app.descendants(matching: .any).matching(identifier: field).firstMatch.value as? String, "") }
        attach("redesign-forward-empty-recipients")
    }
    func testStorageFailureOffersRetryWithoutDeletingData() {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture", "--ui-storage-error"]; app.launch()
        XCTAssertTrue(app.buttons["重试"].waitForExistence(timeout: 5)); attach("redesign-storage-error")
        app.buttons["重试"].tap()
        XCTAssertTrue(app.buttons["compose-mail"].waitForExistence(timeout: 5))
    }
    func testSecondarySettingsAndConfirmationSurfaces() {
        let app = launch()
        app.tabBars.buttons["设置"].tap()
        app.buttons.containing(.staticText, identifier: "测试邮箱").firstMatch.tap()
        XCTAssertTrue(app.buttons["移除此邮箱"].waitForExistence(timeout: 5)); attach("redesign-account-detail")
        app.buttons["移除此邮箱"].tap(); attach("redesign-remove-account-confirmation")
        app.buttons["取消"].firstMatch.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5)); attach("redesign-model-settings")
        app.swipeUp(); app.buttons["清除模型配置"].tap(); attach("redesign-clear-model-confirmation")
        app.buttons["取消"].firstMatch.tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["后台收信与通知"].tap()
        XCTAssertTrue(app.buttons["申请通知权限"].waitForExistence(timeout: 5)); attach("redesign-background-settings")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["关于 MailAI"].tap(); attach("redesign-about")
        app.buttons["隐私与数据"].tap()
        XCTAssertTrue(app.staticTexts["保存在你的设备"].waitForExistence(timeout: 5)); attach("redesign-privacy")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["开源许可"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Apache'")).firstMatch.waitForExistence(timeout: 5)); attach("redesign-licenses")
    }
    func testSearchFailureKeepsLocalResultsAndRecentQuery() {
        let app = launch()
        app.buttons["搜索邮件"].tap()
        let search = app.searchFields.firstMatch
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
        XCTAssertTrue(body.waitForExistence(timeout: 5)); body.tap(); body.typeText("Synthetic accessibility draft")
        XCTAssertTrue(app.buttons["添加附件"].isHittable)
        XCTAssertTrue(app.buttons["收起键盘"].isHittable)
        attach("redesign-compose-accessibility-keyboard")
        app.buttons["收起键盘"].tap()
        XCTAssertTrue(app.buttons["关闭"].isHittable)
    }
    private func attach(_ name: String) {
        let value = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); value.name = name; value.lifetime = .keepAlways; add(value)
    }
}
