import AppKit
import MediaWriterCore
import SwiftUI

/// Command-line switches. Only CI and development use them; a user
/// double-clicking the app gets the bundled helper and the password prompt.
struct LaunchOptions {
    /// `--fake-helper PATH`: use a protocol-speaking stand-in (Fixtures/
    /// fake-helper.sh). Writes then run unprivileged through the events-file
    /// path, never through the administrator prompt.
    var fakeHelper: URL?
    /// `--ui-smoke DIR`: walk the flow by itself and save screenshots to DIR.
    var smokeDirectory: URL?
    /// `--ui-smoke-scenario usb|iso|fail` (default usb).
    var smokeScenario = "usb"
    /// `--catalog-base-url URL` passed to `helper catalog --base-url`.
    var catalogBaseURL: String?

    static func parse(_ arguments: [String]) -> LaunchOptions {
        var options = LaunchOptions()
        var iterator = arguments.dropFirst().makeIterator()
        while let arg = iterator.next() {
            switch arg {
            case "--fake-helper":
                options.fakeHelper = iterator.next().map { URL(fileURLWithPath: $0) }
            case "--ui-smoke":
                options.smokeDirectory = iterator.next().map { URL(fileURLWithPath: $0, isDirectory: true) }
            case "--ui-smoke-scenario":
                options.smokeScenario = iterator.next() ?? options.smokeScenario
            case "--catalog-base-url":
                options.catalogBaseURL = iterator.next()
            default:
                break // AppKit's own -NSDocumentRevisionsDebugMode etc.
            }
        }
        return options
    }

    @MainActor
    func makeController() -> FlowController {
        let helper = fakeHelper
            ?? Bundle.main.url(forAuxiliaryExecutable: "tunaos-media-helper")
            ?? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/tunaos-media-helper")
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let controller = FlowController(
            client: HelperClient(executable: helper),
            writeMode: fakeHelper == nil ? .administrator(prompt: Strings.elevationPrompt) : .eventsFile,
            stagingDirectory: caches.appendingPathComponent("org.tunaos.MediaWriter", isDirectory: true)
        )
        controller.catalogBaseURL = catalogBaseURL
        return controller
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Also correct when the binary is started directly (CI smoke).
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

/// View-only state that the smoke driver also needs to flip.
@MainActor
final class UIState: ObservableObject {
    @Published var showDetails = false
}

@main
struct MediaWriterApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller: FlowController
    @StateObject private var uiState = UIState()
    private let options: LaunchOptions

    init() {
        let options = LaunchOptions.parse(CommandLine.arguments)
        self.options = options
        _controller = StateObject(wrappedValue: options.makeController())
    }

    var body: some Scene {
        Window(Strings.appName, id: "main") {
            RootView()
                .environmentObject(controller)
                .environmentObject(uiState)
                .frame(minWidth: 760, idealWidth: 820, minHeight: 560, idealHeight: 600)
                .task {
                    controller.start()
                    if let directory = options.smokeDirectory {
                        let smoke = UISmoke(
                            controller: controller, uiState: uiState,
                            directory: directory, scenario: options.smokeScenario)
                        await smoke.run()
                    }
                }
        }
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}
