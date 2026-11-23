import Foundation

/// Matches the cloud presets in app/llm/providers.py. Keys never identify a provider.
public enum ModelProviderPreset: String, CaseIterable, Identifiable, Codable, Sendable {
    case deepseek, kimi, kimiCode = "kimi_code", custom
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .deepseek: return "DeepSeek"
        case .kimi: return "Kimi（月之暗面）"
        case .kimiCode: return "Kimi Code（编程订阅）"
        case .custom: return "其他／自部署服务"
        }
    }
    public var endpoint: String {
        switch self {
        case .deepseek: return "https://api.deepseek.com/v1"
        case .kimi: return "https://api.moonshot.cn/v1"
        case .kimiCode: return "https://api.kimi.com/coding/v1"
        case .custom: return ""
        }
    }
    public var model: String {
        switch self {
        case .deepseek: return "deepseek-v4-flash"
        case .kimi: return "kimi-k2.6"
        case .kimiCode: return "kimi-for-coding"
        case .custom: return ""
        }
    }
    public static func matching(endpoint: String) -> Self {
        guard let url = URL(string: endpoint), url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.port == nil || url.port == 443 else { return .custom }
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return allCases.first { preset in
            guard preset != .custom, let base = URL(string: preset.endpoint), base.host?.lowercased() == url.host?.lowercased() else { return false }
            let basePath = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return path == basePath || path == basePath + "/chat/completions" || (preset == .deepseek && ["", "chat/completions"].contains(path))
        } ?? .custom
    }
}
