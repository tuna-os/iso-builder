// swift-tools-version:5.9
//
// TunaOS Media Writer for macOS. `swift build` / `swift test` work without an
// Xcode project; scripts/build-app.sh turns the release binary into a signed
// (or ad-hoc signed) universal .app and a .dmg.
import PackageDescription

let package = Package(
    name: "TunaOSMediaWriter",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TunaOSMediaWriter", targets: ["TunaOSMediaWriter"]),
    ],
    targets: [
        // Everything that does not draw: protocol models, the JSONL parser,
        // helper process management (direct and elevated) and the flow state
        // machine. Unit-tested against Fixtures/fake-helper.sh.
        .target(name: "MediaWriterCore"),
        // SwiftUI views plus the --ui-smoke driver used by CI.
        .executableTarget(
            name: "TunaOSMediaWriter",
            dependencies: ["MediaWriterCore"]
        ),
        .testTarget(
            name: "MediaWriterCoreTests",
            dependencies: ["MediaWriterCore"]
        ),
    ]
)
