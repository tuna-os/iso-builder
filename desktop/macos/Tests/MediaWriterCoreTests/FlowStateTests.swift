import Foundation
@testable import MediaWriterCore
import XCTest

final class FlowStateTests: XCTestCase {
    private let usb = Drive(id: "usb-1", path: "/dev/disk4", name: "SanDisk Ultra", sizeBytes: 32_010_928_128, bus: "usb")
    private let sd = Drive(id: "sd-2", path: "/dev/disk5", name: "SD Card", sizeBytes: 15_938_355_200, bus: "sd")

    private func loaded() throws -> FlowState {
        var state = FlowState()
        XCTAssertEqual(state.reduce(.reloadCatalog), .loadCatalog)
        XCTAssertTrue(state.loadingCatalog)
        state.reduce(.catalogLoaded(try Fixture.catalog))
        XCTAssertFalse(state.loadingCatalog)
        return state
    }

    private func atDestination() throws -> FlowState {
        var state = try loaded()
        state.reduce(.continueToDestination)
        XCTAssertEqual(state.step, .destination)
        return state
    }

    // MARK: Choose

    func testDefaultsComeFromCatalogDefaultTarget() throws {
        let state = try loaded()
        XCTAssertEqual(state.step, .choose)
        XCTAssertEqual(state.platform, "linux/amd64")
        XCTAssertEqual(state.desktopID, "gnome")
        XCTAssertEqual(state.baseID, "yellowfin")
        // Standard/generic wins over the nvidia variant of the same base+desktop.
        XCTAssertEqual(state.selectedTarget?.id, "yellowfin:gnome:linux/amd64")
        XCTAssertEqual(state.availableDesktops.map(\.id), ["gnome", "kde", "niri"])
        XCTAssertEqual(state.availableBases.map(\.id), ["yellowfin", "albacore"])
    }

    func testBaseFollowsDesktop() throws {
        var state = try loaded()
        state.reduce(.selectDesktop("niri"))
        XCTAssertEqual(state.baseID, "skipjack", "only base offering niri")
        state.reduce(.selectDesktop("kde"))
        XCTAssertEqual(state.baseID, "skipjack", "current base kept when it offers the desktop")
        state.reduce(.selectDesktop("gnome"))
        XCTAssertEqual(state.baseID, "yellowfin", "falls back to the catalog default base")
        state.reduce(.selectBase("albacore"))
        XCTAssertEqual(state.selectedTarget?.id, "albacore:gnome:linux/amd64")
        state.reduce(.selectBase("skipjack"))
        XCTAssertEqual(state.baseID, "albacore", "bases not offering the desktop are rejected")
        state.reduce(.selectDesktop("cosmic"))
        XCTAssertEqual(state.desktopID, "gnome", "unknown desktops are rejected")
    }

    func testPlatformSwitch() throws {
        var state = try loaded()
        XCTAssertEqual(state.availablePlatforms, ["linux/amd64", "linux/arm64"])
        state.reduce(.selectPlatform("linux/arm64"))
        XCTAssertEqual(state.availableDesktops.map(\.id), ["gnome"])
        XCTAssertEqual(state.availableBases.map(\.id), ["yellowfin"])
        XCTAssertEqual(state.selectedTarget?.id, "yellowfin:gnome:linux/arm64")
        XCTAssertEqual(state.defaultISOFilename, "tunaos-yellowfin-gnome-arm64.iso")
        state.reduce(.selectPlatform("linux/riscv64"))
        XCTAssertEqual(state.platform, "linux/arm64")
    }

    func testContinueNeedsASource() {
        var state = FlowState()
        XCTAssertNil(state.reduce(.continueToDestination))
        XCTAssertEqual(state.step, .choose)
    }

    func testOpenRequestSkipsToDestinationAndBackClearsIt() throws {
        var state = try loaded()
        let request = BuildSource.request(url: URL(fileURLWithPath: "/tmp/build-request.json"), summary: "yellowfin:kde", outputFilename: "custom.iso")
        state.reduce(.openRequest(request))
        XCTAssertEqual(state.step, .destination)
        XCTAssertEqual(state.source, request)
        XCTAssertEqual(state.defaultISOFilename, "custom.iso")
        state.reduce(.back)
        XCTAssertEqual(state.step, .choose)
        XCTAssertEqual(state.source, .target(state.selectedTarget!))
    }

    // MARK: Destination

    func testDriveSelectionAndHotplug() throws {
        var state = try atDestination()
        state.reduce(.drivesUpdated([usb]))
        XCTAssertEqual(state.selectedDriveID, "usb-1", "a single drive is preselected")
        state.reduce(.drivesUpdated([usb, sd]))
        XCTAssertEqual(state.selectedDriveID, "usb-1", "selection survives a refresh")
        state.reduce(.selectDrive("sd-2"))
        XCTAssertEqual(state.selectedDrive, sd)
        state.reduce(.selectDrive("gone"))
        XCTAssertNil(state.selectedDriveID)
        state.reduce(.selectDrive("sd-2"))
        state.reduce(.drivesUpdated([usb]))
        XCTAssertEqual(state.selectedDriveID, "usb-1", "unplugged selection is cleared, lone drive reselected")
        state.reduce(.drivesUpdated([]))
        XCTAssertNil(state.selectedDriveID)
        state.reduce(.drivesFailed("boom"))
        XCTAssertEqual(state.drivesError, "boom")
        state.reduce(.drivesUpdated([]))
        XCTAssertNil(state.drivesError)
    }

    func testEraseNeedsConfirmation() throws {
        var state = try atDestination()
        XCTAssertNil(state.reduce(.requestErase), "nothing selected")
        XCTAssertNil(state.pendingErase)
        XCTAssertNil(state.reduce(.confirmErase), "no pending confirmation")
        XCTAssertEqual(state.step, .destination)

        state.reduce(.drivesUpdated([usb, sd]))
        state.reduce(.selectDrive("usb-1"))
        state.reduce(.requestErase)
        XCTAssertEqual(state.pendingErase, usb)
        state.reduce(.dismissErase)
        XCTAssertNil(state.pendingErase)
        XCTAssertEqual(state.step, .destination)

        state.reduce(.requestErase)
        let effect = state.reduce(.confirmErase)
        let job = Job(source: .target(state.selectedTarget!), destination: .drive(usb))
        XCTAssertEqual(effect, .startJob(job))
        XCTAssertEqual(state.step, .progress)
        XCTAssertEqual(state.job, job)
        XCTAssertNil(state.pendingErase)
        XCTAssertNil(state.fraction)
        XCTAssertEqual(state.stage, .preparing)
    }

    func testUnpluggingDuringConfirmationCancelsIt() throws {
        var state = try atDestination()
        state.reduce(.drivesUpdated([usb, sd]))
        state.reduce(.selectDrive("sd-2"))
        state.reduce(.requestErase)
        state.reduce(.drivesUpdated([usb]))
        XCTAssertNil(state.pendingErase)
        XCTAssertNil(state.reduce(.confirmErase))
        XCTAssertEqual(state.step, .destination)
    }

    func testSaveISO() throws {
        var state = try atDestination()
        let url = URL(fileURLWithPath: "/tmp/x.iso")
        XCTAssertEqual(state.reduce(.saveISO(url)), .startJob(Job(source: state.source!, destination: .isoFile(url))))
        XCTAssertEqual(state.step, .progress)
    }

    // MARK: Progress

    func testProgressStagesAndMonotonicBar() throws {
        var state = try atDestination()
        state.reduce(.drivesUpdated([usb]))
        state.reduce(.requestErase)
        state.reduce(.confirmErase)

        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "download", current: 50, total: 100, unit: "bytes"))))
        XCTAssertEqual(state.stage, .downloading)
        XCTAssertEqual(state.fraction!, 0.20, accuracy: 0.0001)
        XCTAssertEqual(state.bytesDone, 50)
        XCTAssertEqual(state.bytesTotal, 100)

        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "erofs", current: 0, total: 4, unit: "steps"))))
        XCTAssertEqual(state.stage, .building)
        XCTAssertEqual(state.fraction!, 0.50, accuracy: 0.0001)
        XCTAssertNil(state.bytesDone, "step counts are not shown as sizes")

        // An out-of-order earlier phase never moves the bar backwards.
        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "download", current: 1, total: 100))))
        XCTAssertEqual(state.fraction!, 0.50, accuracy: 0.0001)

        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "mystery", current: 1, total: 1))))
        XCTAssertEqual(state.stage, .downloading, "unknown phases are ignored")

        state.reduce(.awaitingPermission)
        XCTAssertEqual(state.stage, .waitingForPermission)

        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "write", current: 1, total: 2, unit: "bytes"))))
        XCTAssertEqual(state.stage, .writing)
        XCTAssertEqual(state.fraction!, 0.785, accuracy: 0.0001)
        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "verify", current: 2, total: 2, unit: "bytes"))))
        XCTAssertEqual(state.stage, .verifying)
        XCTAssertEqual(state.fraction!, 1.0, accuracy: 0.0001)

        state.reduce(.helperEvent(.log(LogEvent(level: "warn", message: "slow mirror"))))
        state.reduce(.helperEvent(.error(ErrorEvent(kind: "engine", message: "boom"))))
        state.reduce(.appendLog("stderr line\n"))
        XCTAssertEqual(state.log, "[warn] slow mirror\n[error:engine] boom\nstderr line\n")
    }

    func testISOOnlyBands() {
        XCTAssertEqual(OverallProgress.band(for: .download, writesDrive: false), 0...0.60)
        XCTAssertEqual(OverallProgress.band(for: .iso, writesDrive: false).upperBound, 1.0, accuracy: 0.0001)
        XCTAssertEqual(OverallProgress.band(for: .unpack, writesDrive: true).lowerBound, 0.40, accuracy: 0.0001)
        XCTAssertEqual(OverallProgress.band(for: .iso, writesDrive: true).upperBound, 0.65, accuracy: 0.0001)
        XCTAssertEqual(OverallProgress.fraction(ProgressEvent(phase: "download", current: 5, total: 0), writesDrive: false), 0)
        XCTAssertEqual(OverallProgress.fraction(ProgressEvent(phase: "download", current: 500, total: 100), writesDrive: false), 0.6)
    }

    func testEventsOutsideProgressAreIgnored() throws {
        var state = try atDestination()
        state.reduce(.helperEvent(.progress(ProgressEvent(phase: "write", current: 1, total: 2))))
        XCTAssertNil(state.fraction)
        XCTAssertNil(state.reduce(.finished(.wroteDrive(usb))))
        XCTAssertEqual(state.step, .destination)
    }

    // MARK: Done / retry / cancel

    func testFailureTryAgainAndStartOver() throws {
        var state = try atDestination()
        state.reduce(.drivesUpdated([usb]))
        state.reduce(.requestErase)
        state.reduce(.confirmErase)
        state.reduce(.finished(.failed(message: "The USB stick changed.")))
        XCTAssertEqual(state.step, .done)
        XCTAssertEqual(state.outcome, .failed(message: "The USB stick changed."))
        state.reduce(.tryAgain)
        XCTAssertEqual(state.step, .destination)
        XCTAssertNil(state.outcome)
        XCTAssertEqual(state.selectedDriveID, "usb-1", "drive choice is kept for the retry")

        state.reduce(.requestErase)
        state.reduce(.confirmErase)
        state.reduce(.finished(.wroteDrive(usb)))
        XCTAssertEqual(state.outcome, .wroteDrive(usb))
        state.reduce(.startOver)
        XCTAssertEqual(state.step, .choose)
        XCTAssertNil(state.outcome)
        XCTAssertNil(state.job)
    }

    func testCancelReturnsToDestinationWithNotice() throws {
        var state = try atDestination()
        state.reduce(.saveISO(URL(fileURLWithPath: "/tmp/x.iso")))
        state.reduce(.cancelled)
        XCTAssertEqual(state.step, .destination)
        XCTAssertEqual(state.notice, Strings.cancelledNotice)
        XCTAssertNil(state.job)
        state.reduce(.back)
        state.reduce(.continueToDestination)
        XCTAssertNil(state.notice)
    }

    // MARK: Job arguments

    func testHelperArguments() {
        let target = Catalog.Target(id: "yellowfin:gnome:linux/amd64", base: "yellowfin", desktop: "gnome", platform: "linux/amd64")
        XCTAssertEqual(
            Job(source: .target(target), destination: .drive(usb)).buildArguments(output: "/c/out.iso"),
            ["build", "--target", "yellowfin:gnome:linux/amd64", "--out", "/c/out.iso"])
        XCTAssertEqual(
            Job(source: .request(url: URL(fileURLWithPath: "/d/req.json"), summary: "", outputFilename: nil), destination: .drive(usb))
                .buildArguments(output: "/c/out.iso"),
            ["build", "--request", "/d/req.json", "--out", "/c/out.iso"])
        XCTAssertEqual(Job.writeArguments(iso: "/c/out.iso", drive: usb), ["write", "--iso", "/c/out.iso", "--device", "usb-1"])
    }

    func testBuildRequestFile() throws {
        let dir = try Fixture.temporaryDirectory()
        let good = dir.appendingPathComponent("build-request.json")
        try #"{"schemaVersion":1,"image":"ghcr.io/tuna-os/yellowfin:kde","options":{"outputFilename":"yellowfin-kde.iso"}}"#
            .write(to: good, atomically: true, encoding: .utf8)
        XCTAssertEqual(try BuildRequestFile.load(good), .request(url: good, summary: "yellowfin:kde", outputFilename: "yellowfin-kde.iso"))

        let bad = dir.appendingPathComponent("other.json")
        try #"{"schemaVersion":2,"image":"x"}"#.write(to: bad, atomically: true, encoding: .utf8)
        XCTAssertThrowsError(try BuildRequestFile.load(bad)) {
            XCTAssertEqual(($0 as? HelperFailure)?.message, Strings.requestUnreadable)
        }
    }

    func testByteFormattingIsNumeric() {
        XCTAssertFalse(Format.bytes(0).contains("Zero"), Format.bytes(0))
        XCTAssertTrue(Format.bytes(32_010_928_128).contains("32"), Format.bytes(32_010_928_128))
    }
}
