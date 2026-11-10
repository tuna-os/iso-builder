import Foundation
@testable import MediaWriterCore
import XCTest

final class HelperClientTests: XCTestCase {
    func testQueries() async throws {
        let client = Fixture.client()
        let version = try await client.version()
        XCTAssertEqual(version.protocolVersion, supportedHelperProtocol)
        let catalog = try await client.catalog(baseURL: "https://iso.tunaos.org")
        XCTAssertEqual(catalog.bases.first?.id, "yellowfin")
        let drives = try await client.drives(exclude: "/tmp")
        XCTAssertEqual(drives.map(\.id), ["fake-usb-0001", "fake-sd-0002"])
    }

    func testQueryFailureCarriesHelperMessageAndStderr() async {
        do {
            _ = try await Fixture.client(["FAKE_HELPER_FAIL": "catalog"]).catalog()
            XCTFail("expected failure")
        } catch let failure as HelperFailure {
            XCTAssertEqual(failure.message, "Could not reach iso.tunaos.org.")
        } catch {
            XCTFail("\(error)")
        }
    }

    func testDirectBuildStreamsEventsInOrder() async throws {
        let dir = try Fixture.temporaryDirectory()
        let argsLog = dir.appendingPathComponent("args.log")
        let out = dir.appendingPathComponent("out.iso")
        let recorder = EventRecorder()
        let result = await Fixture.client(["FAKE_HELPER_ARGS_LOG": argsLog.path])
            .run(["build", "--target", "yellowfin:gnome:linux/amd64", "--out", out.path], cancellable: true) {
                recorder.record($0)
            }
        XCTAssertEqual(result.exitCode, 0, result.stderr)
        XCTAssertTrue(result.succeeded)
        XCTAssertNil(result.error)
        XCTAssertTrue(result.stderr.contains("building yellowfin:gnome:linux/amd64"))
        XCTAssertEqual(Array(NSOrderedSet(array: recorder.progressPhases)) as? [String],
                       ["download", "unpack", "overlay", "erofs", "esp", "iso"])
        guard case .done(let done)? = recorder.events.last else { return XCTFail("last event not done") }
        XCTAssertEqual(done.path, out.path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: out.path))
        let args = try String(contentsOf: argsLog, encoding: .utf8)
        XCTAssertTrue(args.contains("--cancel-file"), args)
        XCTAssertFalse(args.contains("--events"), "direct mode reads stdout")
    }

    func testFailureExitAndError() async throws {
        let dir = try Fixture.temporaryDirectory()
        let result = await Fixture.client(["FAKE_HELPER_FAIL": "build"])
            .run(["build", "--target", "x", "--out", dir.appendingPathComponent("o.iso").path])
        XCTAssertEqual(result.exitCode, 1)
        XCTAssertFalse(result.cancelled)
        XCTAssertEqual(result.error?.knownKind, .network)
        XCTAssertTrue(result.stderr.contains("pretend the network dropped"))
    }

    func testEventsFileModeTailsTheFile() async throws {
        let dir = try Fixture.temporaryDirectory()
        let iso = dir.appendingPathComponent("in.iso")
        try Data("x".utf8).write(to: iso)
        let argsLog = dir.appendingPathComponent("args.log")
        let recorder = EventRecorder()
        let result = await Fixture.client(["FAKE_HELPER_ARGS_LOG": argsLog.path, "FAKE_HELPER_DELAY": "0.05"])
            .run(["write", "--iso", iso.path, "--device", "fake-usb-0001"], mode: .eventsFile, cancellable: true) {
                recorder.record($0)
            }
        XCTAssertEqual(result.exitCode, 0, result.stderr)
        XCTAssertEqual(recorder.progressPhases.filter { $0 == "write" }.count, 7)
        XCTAssertEqual(recorder.progressPhases.filter { $0 == "verify" }.count, 5)
        XCTAssertEqual(recorder.events.last, .done(DoneEvent(path: nil, device: "fake-usb-0001", bytes: 3_221_225_472, sha256: nil, verified: true)))
        XCTAssertTrue(result.stderr.contains("simulated"), "stderr captured from file")
        let args = try String(contentsOf: argsLog, encoding: .utf8)
        XCTAssertTrue(args.contains("--events"), args)
        XCTAssertTrue(args.contains("--cancel-file"), args)
    }

    func testCancelThroughCancelFile() async throws {
        let dir = try Fixture.temporaryDirectory()
        let iso = dir.appendingPathComponent("in.iso")
        try Data("x".utf8).write(to: iso)
        let recorder = EventRecorder()
        let run = Fixture.client(["FAKE_HELPER_DELAY": "0.3"])
            .start(["write", "--iso", iso.path, "--device", "d"], mode: .eventsFile, cancellable: true) {
                recorder.record($0)
            }
        try await Task.sleep(nanoseconds: 700_000_000)
        run.cancel()
        XCTAssertTrue(run.isCancelRequested)
        let result = await run.result()
        XCTAssertEqual(result.exitCode, 130)
        XCTAssertTrue(result.cancelled)
        XCTAssertEqual(result.error?.knownKind, .cancelled)
        XCTAssertLessThan(recorder.progressPhases.count, 7)
    }

    func testCancelDirectSendsSIGTERM() async throws {
        let dir = try Fixture.temporaryDirectory()
        // No cancel file: only the signal can stop it.
        let run = Fixture.client(["FAKE_HELPER_DELAY": "0.3"])
            .start(["build", "--target", "x", "--out", dir.appendingPathComponent("o.iso").path]) { _ in }
        try await Task.sleep(nanoseconds: 500_000_000)
        run.cancel()
        let result = await run.result()
        XCTAssertTrue(result.cancelled, "exit \(result.exitCode)")
    }

    func testMissingExecutable() async {
        let result = await HelperClient(executable: URL(fileURLWithPath: "/nonexistent/tunaos-media-helper")).run(["version"])
        XCTAssertEqual(result.exitCode, 127)
        XCTAssertEqual(result.error?.message, Strings.helperCouldNotStart)
        do {
            _ = try await HelperClient(executable: URL(fileURLWithPath: "/nonexistent/x")).version()
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.message, Strings.helperCouldNotStart)
        }
    }

    // MARK: Elevation command

    func testShellQuoting() {
        XCTAssertEqual(HelperClient.shellQuote("plain"), "'plain'")
        XCTAssertEqual(HelperClient.shellQuote("it's"), #"'it'\''s'"#)
        XCTAssertEqual(HelperClient.shellQuote("$(rm -rf /) `x` \"q\""), #"'$(rm -rf /) `x` "q"'"#)
    }

    func testElevatedCommandRoundTripsThroughShell() throws {
        // The command must reproduce the exact argv when /bin/sh runs it.
        let dir = try Fixture.temporaryDirectory()
        let printer = dir.appendingPathComponent("print args.sh")
        try "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\necho to-stderr >&2\nexit 7\n"
            .write(to: printer, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: printer.path)
        let args = ["write", "--iso", "/Users/Jo's Mac/TunaOS \"beta\".iso", "--device", "$(id) `id` \\n"]
        let stderrPath = dir.appendingPathComponent("err log").path
        let exitPath = dir.appendingPathComponent("exit").path
        let command = HelperClient.elevatedShellCommand(
            executable: printer.path, args: args, stderrPath: stderrPath, exitCodePath: exitPath)
            .replacingOccurrences(of: " >/dev/null", with: "")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        let out = Pipe()
        process.standardOutput = out
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(String(decoding: data, as: UTF8.self), args.joined(separator: "\n") + "\n")
        XCTAssertEqual(try String(contentsOfFile: exitPath, encoding: .utf8), "7\n")
        XCTAssertEqual(try String(contentsOfFile: stderrPath, encoding: .utf8), "to-stderr\n")
    }

    func testOsascriptArguments() {
        let args = HelperClient.osascriptArguments(shellCommand: #"'a' "b" \c"#, prompt: "Needs \"password\"")
        XCTAssertEqual(args.count, 6)
        XCTAssertEqual(args[3], #"do shell script "'a' \"b\" \\c" with prompt "Needs \"password\"" with administrator privileges"#)
        XCTAssertEqual(args[1], "with timeout of 86400 seconds")
        XCTAssertEqual(args[5], "end timeout")
    }

    #if os(macOS)
    /// Compiles (without running) the AppleScript the app would hand to
    /// osascript, so a quoting mistake fails here rather than at the
    /// password prompt.
    func testOsascriptSourceCompiles() throws {
        let dir = try Fixture.temporaryDirectory()
        let command = HelperClient.elevatedShellCommand(
            executable: "/Applications/TunaOS Media Writer.app/Contents/MacOS/tunaos-media-helper",
            args: ["write", "--iso", "/Users/Jo's Mac/a \"b\".iso", "--device", "x\\y"],
            stderrPath: "/tmp/e", exitCodePath: "/tmp/x")
        let args = HelperClient.osascriptArguments(shellCommand: command, prompt: Strings.elevationPrompt)
        let source = stride(from: 1, to: args.count, by: 2).map { args[$0] }.joined(separator: "\n")
        let script = dir.appendingPathComponent("s.applescript")
        try source.write(to: script, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osacompile")
        process.arguments = ["-o", dir.appendingPathComponent("s.scpt").path, script.path]
        let err = Pipe()
        process.standardError = err
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))
    }
    #endif
}
