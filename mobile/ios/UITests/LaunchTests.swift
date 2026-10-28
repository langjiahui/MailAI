import XCTest

final class LaunchTests: XCTestCase {
    private func openAccountForm(_ app: XCUIApplication) {
        app.launch()
        XCTAssertTrue(app.buttons["add-account"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts["操作提示"].exists, "Startup must not hide a Keychain failure")
        app.buttons["add-account"].tap()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.buttons["add-account"].waitForExistence(timeout: 5))
        app.buttons["add-account"].tap()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["email"].value as? String, "邮箱地址")
        XCTAssertFalse(app.buttons["validate-account"].isEnabled)
    }
    func testUnknownDomainPrefillsDefaultsInsideOptionalSettings() {
        let app = XCUIApplication(); openAccountForm(app)
        app.textFields["email"].tap(); app.textFields["email"].typeText("demo@corp.example")
        XCTAssertTrue(app.staticTexts["provider-status"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["provider-status"].label.contains("默认"))
        XCTAssertFalse(app.textFields["imap-host"].exists)
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
    private func launch(dark: Bool = false, large: Bool = false) -> XCUIApplication {
        let app = XCUIApplication(); app.launchArguments = ["--ui-fixture"]
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
        attach("blue-reader-light")
        app.buttons["回复全部"].tap()
        XCTAssertTrue(app.textFields["compose-to"].waitForExistence(timeout: 5))
        XCTAssertTrue((app.textFields["compose-to"].value as? String)?.contains("sender@example.com") == true)
        XCTAssertTrue((app.textFields["compose-cc"].value as? String)?.contains("team@example.com") == true)
        XCTAssertTrue(app.buttons["添加文件"].exists)
        attach("blue-compose-light")
        app.buttons["关闭"].tap(); app.buttons["保存并返回"].tap()
        XCTAssertTrue(app.buttons["回复全部"].waitForExistence(timeout: 5))
    }
    func testContactsAndSettingsInDarkMode() {
        let app = launch(dark: true)
        app.tabBars.buttons["通讯录"].tap()
        XCTAssertTrue(app.staticTexts["项目组"].waitForExistence(timeout: 5)); attach("blue-contacts-dark")
        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(app.staticTexts["宝武蓝 · 蓝白"].waitForExistence(timeout: 5)); attach("blue-settings-dark")
        app.swipeUp()
        app.buttons["小邮与模型服务"].tap()
        XCTAssertTrue(app.secureTextFields["API Key"].waitForExistence(timeout: 5))
    }
    func testLargeTextKeepsComposeAndNavigationReachable() {
        let app = launch(dark: true, large: true)
        XCTAssertTrue(app.buttons["compose-mail"].isHittable)
        app.buttons["compose-mail"].tap()
        XCTAssertTrue(app.buttons["关闭"].waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["send-mail"].exists)
        attach("blue-compose-accessibility-dark")
    }
    private func attach(_ name: String) {
        let value = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); value.name = name; value.lifetime = .keepAlways; add(value)
    }
}
