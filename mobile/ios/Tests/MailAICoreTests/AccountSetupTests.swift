import XCTest
@testable import MailAICore

final class AccountSetupTests: XCTestCase {
    func testKnownMailboxNeedsOnlyEmailAndDefaultsUsername() throws {
        var setup = AccountSetup(); setup.updateEmail(" Demo@QQ.COM ")
        let account = try setup.preparedAccount()
        XCTAssertEqual(account.email, "Demo@QQ.COM")
        XCTAssertEqual(account.username, "Demo@QQ.COM")
        XCTAssertEqual(account.imapHost, "imap.qq.com"); XCTAssertEqual(account.imapPort, 993)
        XCTAssertEqual(account.smtpHost, "smtp.qq.com"); XCTAssertEqual(account.smtpPort, 465)
        XCTAssertEqual(account.imapSecurity, .tls); XCTAssertEqual(account.smtpSecurity, .tls)
    }
    func testUnknownDomainGetsWebCompatibleDefaults() throws {
        var setup = AccountSetup(); setup.updateEmail("demo@corp.example")
        let account = try setup.preparedAccount()
        XCTAssertNil(setup.provider); XCTAssertFalse(setup.manualServers)
        XCTAssertEqual(account.username, "demo@corp.example")
        XCTAssertEqual(account.imapHost, "imap.corp.example")
        XCTAssertEqual(account.smtpHost, "smtp.corp.example")
        XCTAssertEqual(account.imapPort, 993); XCTAssertEqual(account.smtpPort, 465)
    }
    func testSwitchingFromICloudResetsEveryTransportSetting() throws {
        var setup = AccountSetup(); setup.updateEmail("demo@icloud.com")
        XCTAssertEqual(setup.account.smtpPort, 587); XCTAssertEqual(setup.account.smtpSecurity, .startTLS)
        setup.updateEmail("demo@163.com")
        XCTAssertEqual(setup.account.smtpPort, 465); XCTAssertEqual(setup.account.smtpSecurity, .tls)
        XCTAssertEqual(setup.account.smtpHost, "smtp.163.com")
        setup.updateEmail("demo@corp.example")
        XCTAssertEqual(setup.account.imapHost, "imap.corp.example")
        XCTAssertEqual(setup.account.smtpHost, "smtp.corp.example")
        XCTAssertEqual(setup.account.smtpSecurity, .tls)
    }
    func testPresetMatchingNeverUsesASuffixOrSubstring() {
        for email in ["demo@qq.com.evil.example", "demo@myqq.com", "demo@sub.163.com", "demo@noticloud.com"] {
            XCTAssertNil(MailProvider.match(email: email), email)
        }
    }
    func testInvalidEmailDoesNotProduceSuggestedEndpoints() {
        for email in ["", "demo", "a@@qq.com", "a@localhost", "a@corp..example", "a@-corp.example", "a@corp.example/"] {
            XCTAssertNil(AccountSetup.suggestedDomain(email: email), email)
            var setup = AccountSetup(); setup.updateEmail(email)
            XCTAssertThrowsError(try setup.preparedAccount(), email)
        }
    }
    func testManualServersSurviveLocalPartEditsButNotAnotherDomain() throws {
        var setup = AccountSetup(); setup.updateEmail("first@corp.example")
        setup.setServer(\.imapHost, "mail.corp.example"); setup.setServer(\.smtpHost, "mail.corp.example")
        setup.setServer(\.smtpPort, 587); setup.setServer(\.smtpSecurity, .startTLS)
        setup.set(\.username, "custom-login")
        XCTAssertEqual(try setup.preparedAccount().username, "custom-login")
        setup.updateEmail("second@corp.example")
        XCTAssertTrue(setup.manualServers)
        XCTAssertEqual(setup.account.imapHost, "mail.corp.example")
        XCTAssertEqual(setup.account.smtpSecurity, .startTLS)
        XCTAssertEqual(setup.account.username, "second@corp.example")
        setup.updateEmail("other@qq.com")
        XCTAssertFalse(setup.manualServers)
        XCTAssertEqual(setup.account.imapHost, "imap.qq.com")
        XCTAssertEqual(setup.account.smtpPort, 465); XCTAssertEqual(setup.account.smtpSecurity, .tls)
    }
    func testRestorePresetsDoesNotOverwriteDisplayNameOrCustomUsername() throws {
        var setup = AccountSetup(); setup.updateEmail("demo@me.com")
        setup.set(\.displayName, "Demo"); setup.set(\.username, "custom-login")
        setup.setServer(\.smtpHost, "custom.example"); setup.setServer(\.smtpPort, 1234)
        setup.restoreAutomaticServers()
        XCTAssertFalse(setup.manualServers)
        XCTAssertEqual(setup.account.smtpHost, "smtp.mail.me.com")
        XCTAssertEqual(setup.account.smtpPort, 587); XCTAssertEqual(setup.account.smtpSecurity, .startTLS)
        XCTAssertEqual(setup.account.username, "custom-login"); XCTAssertEqual(setup.account.displayName, "Demo")
    }
    func testProviderCatalogMatchesWebProfiles() throws {
        let profiles: [(String, String, String, Int)] = [
            ("foxmail.com", "imap.qq.com", "smtp.qq.com", 465),
            ("126.com", "imap.126.com", "smtp.126.com", 465),
            ("yeah.net", "imap.yeah.net", "smtp.yeah.net", 465),
            ("gmail.com", "imap.gmail.com", "smtp.gmail.com", 465),
            ("googlemail.com", "imap.gmail.com", "smtp.gmail.com", 465),
            ("outlook.com", "outlook.office365.com", "smtp.office365.com", 587),
            ("hotmail.com", "outlook.office365.com", "smtp.office365.com", 587),
            ("live.com", "outlook.office365.com", "smtp.office365.com", 587),
            ("office365.com", "outlook.office365.com", "smtp.office365.com", 587),
            ("icloud.com", "imap.mail.me.com", "smtp.mail.me.com", 587),
            ("me.com", "imap.mail.me.com", "smtp.mail.me.com", 587),
            ("mac.com", "imap.mail.me.com", "smtp.mail.me.com", 587),
            ("yahoo.com", "imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465),
            ("aliyun.com", "imap.aliyun.com", "smtp.aliyun.com", 465),
            ("sina.com", "imap.sina.com", "smtp.sina.com", 465),
            ("sohu.com", "imap.sohu.com", "smtp.sohu.com", 465),
            ("139.com", "imap.139.com", "smtp.139.com", 465)
        ]
        for (domain, imap, smtp, port) in profiles {
            var setup = AccountSetup(); setup.updateEmail("demo@" + domain)
            let account = try setup.preparedAccount()
            XCTAssertNotNil(setup.provider); XCTAssertEqual(account.imapHost, imap)
            XCTAssertEqual(account.smtpHost, smtp); XCTAssertEqual(account.smtpPort, port)
            XCTAssertEqual(account.smtpSecurity, port == 587 ? .startTLS : .tls)
        }
    }
}
