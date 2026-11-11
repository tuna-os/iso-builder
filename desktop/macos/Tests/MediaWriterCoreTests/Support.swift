import Foundation
@testable import MediaWriterCore
import XCTest

enum Fixture {
    /// desktop/macos/Fixtures/fake-helper.sh
    static let fakeHelper = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // MediaWriterCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // desktop/macos
        .appendingPathComponent("Fixtures/fake-helper.sh")

    static func client(_ env: [String: String] = [:]) -> HelperClient {
        HelperClient(executable: fakeHelper, environment: env)
    }

    static func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("mw-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The catalog the fake helper prints, parsed through the real parser.
    static var catalog: Catalog {
        get throws {
            let process = Process()
            process.executableURL = fakeHelper
            process.arguments = ["catalog"]
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            var stream = HelperEventStream()
            for event in stream.append(data) {
                if case .catalog(let catalog) = event { return catalog }
            }
            throw HelperFailure(message: "fake helper printed no catalog", details: "")
        }
    }
}

/// Thread-safe event recorder for helper callbacks.
final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [HelperEvent] = []

    func record(_ event: HelperEvent) {
        lock.lock(); storage.append(event); lock.unlock()
    }

    var events: [HelperEvent] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }

    var progressPhases: [String] {
        events.compactMap { if case .progress(let p) = $0 { return p.phase } else { return nil } }
    }
}

@MainActor
func waitUntil(
    _ what: String, timeout: TimeInterval = 30,
    file: StaticString = #filePath, line: UInt = #line,
    _ condition: () -> Bool
) async {
    let end = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > end {
            XCTFail("timed out waiting for \(what)", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
}
