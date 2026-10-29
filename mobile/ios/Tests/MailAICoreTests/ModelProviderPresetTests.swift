import XCTest
@testable import MailAICore

final class ModelProviderPresetTests: XCTestCase {
    func testCloudPresetsMatchWebAndDoNotMistakeOtherHostsForProviders() {
        XCTAssertEqual(ModelProviderPreset.deepseek.endpoint, "https://api.deepseek.com/v1")
        XCTAssertEqual(ModelProviderPreset.deepseek.model, "deepseek-v4-flash")
        XCTAssertEqual(ModelProviderPreset.kimi.model, "kimi-k2.6")
        XCTAssertEqual(ModelProviderPreset.kimiCode.endpoint, "https://api.kimi.com/coding/v1")
        XCTAssertEqual(ModelProviderPreset.matching(endpoint: "https://api.deepseek.com/v1/chat/completions"), .deepseek)
        XCTAssertEqual(ModelProviderPreset.matching(endpoint: "https://api.moonshot.cn/v1/"), .kimi)
        XCTAssertEqual(ModelProviderPreset.matching(endpoint: "https://api.deepseek.com.evil.invalid/v1"), .custom)
        XCTAssertEqual(ModelProviderPreset.matching(endpoint: "http://api.deepseek.com/v1"), .custom)
        XCTAssertEqual(ModelProviderPreset.matching(endpoint: "https://gateway.example.com/v1"), .custom)
    }
}
