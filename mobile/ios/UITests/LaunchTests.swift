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
