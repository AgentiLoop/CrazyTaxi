// swift-tools-version:5.9
// The macOS app: a window with a WKWebView that plays the built game (dist/) and
// serves local-assets/ from disk. Build with mac/build.sh (makes build/CrazyTaxi.app).
import PackageDescription

let package = Package(
    name: "CrazyTaxi",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CrazyTaxi",
            path: "Sources/CrazyTaxi",
            linkerSettings: [.linkedFramework("WebKit"), .linkedFramework("AppKit")]
        ),
    ]
)
