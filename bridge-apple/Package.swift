// swift-tools-version: 6.0
//
// Optional component. Builds the on-device bridge the /api/llm proxy spawns.
//
// Requires full Xcode: FoundationModels.framework is not in the Command Line
// Tools SDK. `npm run build:apple` invokes this; when the binary is absent the
// app simply greys the provider out.
import PackageDescription

let package = Package(
    name: "chesscoach-apple-llm",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "chesscoach-apple-llm")
    ]
)
