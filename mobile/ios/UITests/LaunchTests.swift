import XCTest

final class LaunchTests: XCTestCase {
    func testOnboardingAndAccountForm() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["add-account"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.alerts["操作提示"].exists, "Startup must not hide a Keychain failure")
        attach("welcome")
        app.buttons["add-account"].tap()
        XCTAssertTrue(app.textFields["email"].waitForExistence(timeout: 5))
        app.textFields["email"].tap()
        app.textFields["email"].typeText("demo@example.com")
        app.swipeUp()
        attach("account-form")
        // No network attempt: the test never presses Validate and Save.
        app.buttons["取消"].firstMatch.tap()
        XCTAssertTrue(app.buttons["add-account"].waitForExistence(timeout: 5))
    }
    private func attach(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
