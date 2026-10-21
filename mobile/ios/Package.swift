// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MailAICore",
    platforms: [.iOS("18.0"), .macOS("15.0")],
    products: [.library(name: "MailAICore", targets: ["MailAICore"])],
    targets: [
        .target(name: "MailAICore"),
        .testTarget(name: "MailAICoreTests", dependencies: ["MailAICore"])
    ]
)
