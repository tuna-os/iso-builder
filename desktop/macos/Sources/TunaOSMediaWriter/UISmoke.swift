import AppKit
import MediaWriterCore
import SwiftUI

/// `--ui-smoke DIR`: drives the real window through the flow against the fake
/// helper and saves, per step,
///   NN-name.png         `screencapture -l <window>` (what the user sees)
///   NN-name-screen.png  whole screen (catches sheets/dialogs)
///   NN-name-view.png    in-process render of the window's content view
///                       (works without the Screen Recording permission)
///   NN-name.json        flow state at that moment
/// then exits 0 if every expectation held, 1 otherwise (see smoke.log).
@MainActor
final class UISmoke {
    private let controller: FlowController
    private let uiState: UIState
    private let directory: URL
    private let scenario: String
    private var index = 0
    private var log = ""
    private var failed = false

    init(controller: FlowController, uiState: UIState, directory: URL, scenario: String) {
        self.controller = controller
        self.uiState = uiState
        self.directory = directory
        self.scenario = scenario
    }

    func run() async {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        note("scenario \(scenario)")
        let deadline = Date().addingTimeInterval(240)
        Task { @MainActor in
            // Never hang CI.
            try? await Task.sleep(nanoseconds: UInt64(max(deadline.timeIntervalSinceNow, 1) * 1_000_000_000))
            self.fail("timed out")
            self.exit()
        }

        await expect("catalog loaded") { self.state.catalog != nil }
        await capture("choose")

        controller.send(.continueToDestination)
        await expect("destination step") { self.state.step == .destination }

        switch scenario {
        case "iso":
            await expect("drives listed") { !self.state.drives.isEmpty }
            await capture("destination")
            let out = directory.appendingPathComponent("smoke-output.iso")
            controller.send(.saveISO(out))
        default:
            await expect("drives listed") { !self.state.drives.isEmpty }
            controller.send(.selectDrive(state.drives.first?.id))
            await capture("destination")
            controller.send(.requestErase)
            await expect("erase confirmation open") { self.state.pendingErase != nil }
            await capture("erase-confirmation")
            controller.send(.confirmErase)
        }

        await expect("progress step") { self.state.step == .progress }
        await expect("progress advanced", timeout: 60) {
            self.state.step != .progress || (self.state.fraction ?? 0) > 0.25
        }
        await capture("progress")
        if scenario == "usb" {
            await expect("writing to the stick", timeout: 60) {
                self.state.step != .progress || self.state.stage == .writing || self.state.stage == .verifying
            }
            await capture("progress-writing")
        }

        await expect("done step", timeout: 120) { self.state.step == .done }
        switch (scenario, state.outcome) {
        case ("usb", .wroteDrive?), ("iso", .savedISO?):
            note("outcome ok: \(String(describing: state.outcome))")
        case ("fail", .failed?):
            uiState.showDetails = true
            note("outcome ok (expected failure): \(String(describing: state.outcome))")
        default:
            fail("unexpected outcome \(String(describing: state.outcome)) for scenario \(scenario)")
        }
        await capture("done")
        exit()
    }

    private var state: FlowState { controller.state }

    // MARK: Helpers

    private func note(_ line: String) {
        log += line + "\n"
        FileHandle.standardError.write(Data(("ui-smoke: " + line + "\n").utf8))
    }

    private func fail(_ line: String) {
        failed = true
        note("FAIL: " + line)
    }

    private func expect(_ what: String, timeout: TimeInterval = 30, _ condition: @escaping () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end {
                fail("\(what) (state step=\(state.step) error=\(state.catalogError?.message ?? "-"))")
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        note("ok: \(what)")
    }

    private func capture(_ name: String) async {
        // Let SwiftUI lay out and animations (sheet slide-in) finish.
        try? await Task.sleep(nanoseconds: 1_200_000_000)
        index += 1
        let base = String(format: "%02d-%@", index, name)
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.title == Strings.appName })
            ?? NSApp.windows.first(where: \.isVisible)
        else {
            fail("no visible window for \(name)")
            return
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        await screencapture(["-x", "-o", "-l", String(window.windowNumber)], to: base + ".png")
        if let sheet = window.attachedSheet {
            await screencapture(["-x", "-o", "-l", String(sheet.windowNumber)], to: base + "-sheet.png")
        }
        await screencapture(["-x"], to: base + "-screen.png")

        if let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: directory.appendingPathComponent(base + "-view.png"))
            }
        }

        let snapshot: [String: Any] = [
            "step": "\(state.step)",
            "stage": state.stage.label,
            "fraction": state.fraction ?? -1,
            "desktop": state.desktopID ?? "",
            "base": state.baseID ?? "",
            "platform": state.platform,
            "drives": state.drives.map(\.name),
            "selectedDrive": state.selectedDriveID ?? "",
            "pendingErase": state.pendingErase?.name ?? "",
            "outcome": state.outcome.map { "\($0)" } ?? "",
            "windowSheet": window.attachedSheet != nil,
        ]
        if let json = try? JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys]) {
            try? json.write(to: directory.appendingPathComponent(base + ".json"))
        }
        note("captured \(base)")
    }

    private func screencapture(_ args: [String], to file: String) async {
        let path = directory.appendingPathComponent(file).path
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = args + [path]
            try? process.run()
            process.waitUntilExit()
        }.value
    }

    private func exit() {
        note(failed ? "result: FAILED" : "result: PASSED")
        try? log.write(to: directory.appendingPathComponent("smoke.log"), atomically: true, encoding: .utf8)
        Foundation.exit(failed ? 1 : 0)
    }
}
