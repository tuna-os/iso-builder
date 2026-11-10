import Foundation
@testable import MediaWriterCore
import XCTest

/// The whole flow against the fake helper: real processes, real JSONL, the
/// events-file path for writes (what the elevated write uses), no UI.
@MainActor
final class FlowControllerTests: XCTestCase {
    private lazy var directory: URL = try! Fixture.temporaryDirectory()
    private var argsLog: URL { directory.appendingPathComponent("args.log") }

    private func makeController(_ env: [String: String] = [:]) -> FlowController {
        var environment = ["FAKE_HELPER_ARGS_LOG": argsLog.path]
        environment.merge(env) { _, new in new }
        let controller = FlowController(
            client: Fixture.client(environment),
            writeMode: .eventsFile,
            stagingDirectory: directory.appendingPathComponent("staging"))
        controller.drivePollInterval = 0.1
        return controller
    }

    private func invocations() -> [String] {
        ((try? String(contentsOf: argsLog, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    private func toDestination(_ controller: FlowController) async {
        controller.start()
        await waitUntil("catalog") { controller.state.catalog != nil }
        controller.send(.continueToDestination)
        await waitUntil("drives") { !controller.state.drives.isEmpty }
    }

    func testUSBFlowHappyPath() async throws {
        let controller = makeController()
        await toDestination(controller)
        XCTAssertEqual(controller.state.drives.count, 2)
        controller.send(.selectDrive("fake-usb-0001"))
        controller.send(.requestErase)
        XCTAssertEqual(controller.state.pendingErase?.name, "SanDisk Ultra")
        controller.send(.confirmErase)
        XCTAssertEqual(controller.state.step, .progress)

        await waitUntil("writing stage") { controller.state.stage == .writing || controller.state.step == .done }
        await waitUntil("done") { controller.state.step == .done }
        XCTAssertEqual(controller.state.outcome, .wroteDrive(controller.state.drives.first { $0.id == "fake-usb-0001" }!))
        XCTAssertEqual(controller.state.fraction ?? 0, 1.0, accuracy: 0.0001)

        let calls = invocations()
        XCTAssertTrue(calls.contains { $0.hasPrefix("version") })
        XCTAssertTrue(calls.contains { $0.hasPrefix("catalog") })
        XCTAssertTrue(calls.contains { $0.hasPrefix("drives --exclude") })
        let build = try XCTUnwrap(calls.first { $0.hasPrefix("build") })
        XCTAssertTrue(build.contains("--target yellowfin:gnome:linux/amd64"), build)
        let write = try XCTUnwrap(calls.first { $0.hasPrefix("write") })
        XCTAssertTrue(write.contains("--device fake-usb-0001"), write)
        XCTAssertTrue(write.contains("--events"), write)
        XCTAssertTrue(write.contains("--cancel-file"), write)

        let staged = directory.appendingPathComponent("staging/tunaos-yellowfin-gnome-amd64.iso")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path), "staged ISO removed after a good write")

        // Drive polling stops once the Destination step is left.
        let pollsAtDone = invocations().filter { $0.hasPrefix("drives") }.count
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(invocations().filter { $0.hasPrefix("drives") }.count, pollsAtDone)
    }

    func testSaveISOOnly() async throws {
        let controller = makeController()
        controller.start()
        await waitUntil("catalog") { controller.state.catalog != nil }
        controller.send(.selectDesktop("kde"))
        controller.send(.continueToDestination)
        XCTAssertEqual(controller.state.step, .destination)
        let out = directory.appendingPathComponent("My TunaOS.iso")
        controller.send(.saveISO(out))
        await waitUntil("done") { controller.state.step == .done }
        XCTAssertEqual(controller.state.outcome, .savedISO(out))
        XCTAssertTrue(try String(contentsOf: out, encoding: .utf8).hasPrefix("FAKE-ISO yellowfin:kde:linux/amd64"))
        XCTAssertFalse(invocations().contains { $0.hasPrefix("write") })
    }

    func testWriteFailureShowsMessageAndRetryReusesBuiltISO() async throws {
        let controller = makeController(["FAKE_HELPER_FAIL": "write"])
        await toDestination(controller)
        controller.send(.selectDrive("fake-sd-0002"))
        controller.send(.requestErase)
        controller.send(.confirmErase)
        await waitUntil("done") { controller.state.step == .done }
        XCTAssertEqual(controller.state.outcome,
                       .failed(message: "The USB stick was unplugged or changed. Plug it in again and retry."))
        XCTAssertTrue(controller.state.log.contains("simulated"), controller.state.log)
        XCTAssertTrue(controller.state.log.contains("[error:device-changed]"), controller.state.log)

        controller.send(.tryAgain)
        XCTAssertEqual(controller.state.step, .destination)
        controller.send(.requestErase)
        controller.send(.confirmErase)
        await waitUntil("done again") { controller.state.step == .done }
        XCTAssertEqual(invocations().filter { $0.hasPrefix("build") }.count, 1, "second attempt reuses the staged ISO")
        XCTAssertEqual(invocations().filter { $0.hasPrefix("write") }.count, 2)
    }

    func testBuildFailure() async {
        let controller = makeController(["FAKE_HELPER_FAIL": "build"])
        await toDestination(controller)
        controller.send(.requestErase) // nothing selected yet: two drives
        XCTAssertNil(controller.state.pendingErase)
        controller.send(.selectDrive("fake-usb-0001"))
        controller.send(.requestErase)
        controller.send(.confirmErase)
        await waitUntil("done") { controller.state.step == .done }
        XCTAssertEqual(controller.state.outcome,
                       .failed(message: "The download was interrupted. Check your internet connection and try again."))
        XCTAssertFalse(invocations().contains { $0.hasPrefix("write") })
    }

    func testCancelDuringBuild() async throws {
        let controller = makeController(["FAKE_HELPER_DELAY": "0.2"])
        await toDestination(controller)
        controller.send(.selectDrive("fake-usb-0001"))
        controller.send(.requestErase)
        controller.send(.confirmErase)
        await waitUntil("downloading") { controller.state.stage == .downloading }
        controller.cancel()
        await waitUntil("back at destination") { controller.state.step == .destination }
        XCTAssertEqual(controller.state.notice, Strings.cancelledNotice)
        XCTAssertFalse(invocations().contains { $0.hasPrefix("write") })
    }

    func testCancelDuringWrite() async throws {
        let controller = makeController(["FAKE_HELPER_DELAY": "0.15"])
        await toDestination(controller)
        controller.send(.selectDrive("fake-usb-0001"))
        controller.send(.requestErase)
        controller.send(.confirmErase)
        await waitUntil("writing", timeout: 60) { controller.state.stage == .writing }
        controller.cancel()
        await waitUntil("back at destination") { controller.state.step == .destination }
        XCTAssertEqual(controller.state.notice, Strings.cancelledNotice)
    }

    func testProtocolMismatchBlocksTheApp() async {
        let controller = makeController(["FAKE_HELPER_PROTOCOL": "2"])
        controller.start()
        await waitUntil("catalog error") { controller.state.catalogError != nil }
        XCTAssertEqual(controller.state.catalogError?.message, Strings.helperTooOld)
        XCTAssertNil(controller.state.catalog)
    }

    func testCatalogFailureAndRetry() async {
        let controller = makeController(["FAKE_HELPER_FAIL": "catalog"])
        controller.start()
        await waitUntil("catalog error") { controller.state.catalogError != nil }
        XCTAssertEqual(controller.state.catalogError?.message, "Could not reach iso.tunaos.org.")
        controller.start() // catalog still nil and not loading: start() retries
        await waitUntil("reloaded") { !controller.state.loadingCatalog }
    }

    func testDrivesFailureIsSurfaced() async {
        let controller = makeController(["FAKE_HELPER_FAIL": "drives"])
        controller.start()
        await waitUntil("catalog") { controller.state.catalog != nil }
        controller.send(.continueToDestination)
        await waitUntil("drives error") { controller.state.drivesError != nil }
        XCTAssertEqual(controller.state.drivesError, "Could not list drives.")
    }
}
