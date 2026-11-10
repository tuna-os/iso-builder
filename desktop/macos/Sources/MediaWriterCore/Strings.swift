import Foundation

/// Every user-visible string, in one place for later localization. Keep the
/// main path free of jargon (no "OCI", "bootc", "EROFS", "ISO" only where the
/// user explicitly asked for a file).
public enum Strings {
    public static let appName = "TunaOS Media Writer"

    // Step titles (sidebar/header)
    public static let stepChoose = "Choose"
    public static let stepDestination = "USB stick"
    public static let stepProgress = "Create"
    public static let stepDone = "Done"

    // 1. Choose
    public static let chooseTitle = "Choose your TunaOS"
    public static let chooseSubtitle = "Pick a desktop. You can change the base system below."
    public static let baseLabel = "Base system"
    public static let moreOptions = "More options"
    public static let computerTypeLabel = "Computer type"
    public static let continueButton = "Continue"
    public static let openRequestButton = "Open build request…"
    public static let openRequestMessage = "Choose a build request exported from iso.tunaos.org."
    public static let loadingCatalog = "Loading the list of available systems…"
    public static let catalogFailedTitle = "Couldn't load the list of systems"
    public static let retryButton = "Retry"
    public static let requestUnreadable = "That file is not a TunaOS build request."
    public static let fromRequestLabel = "From build request"

    public static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "linux/amd64", "linux/amd64/v2": return "Intel or AMD PC"
        case "linux/arm64": return "ARM PC"
        default: return platform
        }
    }

    // 2. Destination
    public static let destinationTitle = "Choose a USB stick"
    public static let destinationSubtitle = "Plug in a USB stick of 8 GB or more. It will be erased."
    public static let noDrives = "No USB stick found. Plug one in — it shows up here automatically."
    public static let writeButton = "Write to USB stick"
    public static let saveISOButton = "Save ISO file only…"
    public static let backButton = "Back"
    public static let savePanelMessage = "Choose where to save the ISO file."
    public static let eraseButton = "Erase and Write"
    public static let cancelButton = "Cancel"

    public static func eraseTitle(name: String, size: String) -> String {
        "Erase \(name) (\(size))?"
    }
    public static let eraseMessage = "Everything on it will be deleted."

    // 3. Progress
    public static let progressTitleUSB = "Creating your USB stick"
    public static let progressTitleISO = "Creating your ISO file"
    public static let phasePreparing = "Getting ready"
    public static let phaseDownloading = "Downloading"
    public static let phaseBuilding = "Building"
    public static let phaseWaitingForPermission = "Waiting for your password"
    public static let phaseWriting = "Writing"
    public static let phaseVerifying = "Verifying"
    public static let permissionHint = "macOS asks for your password so the app can write to the USB stick."
    public static let keepPluggedIn = "Keep the USB stick plugged in and your Mac awake."
    public static let elevationPrompt = "TunaOS Media Writer needs your password to write to the USB stick."

    public static func bytesProgress(current: String, total: String) -> String {
        "\(current) of \(total)"
    }

    // 4. Done
    public static let doneTitleUSB = "Your USB stick is ready"
    public static let doneMessageUSB = "Your USB stick is ready. Restart your computer and boot from it."
    public static let doneTitleISO = "Your ISO file is saved"
    public static let doneMessageISO = "Write it to a USB stick, then restart your computer and boot from it."
    public static let showInFinder = "Show in Finder"
    public static let installDocsLink = "How to install TunaOS"
    public static let installDocsURL = URL(string: "https://tunaos.org/docs")!
    public static let startOver = "Make another"
    public static let quitButton = "Quit"

    public static let failedTitle = "That didn't work"
    public static let tryAgain = "Try again"
    public static let showDetails = "Show details"
    public static let hideDetails = "Hide details"
    public static let noDetails = "No details were recorded."

    public static let cancelledNotice = "Cancelled. If writing had already started, write the USB stick again before using it."

    // Errors synthesised by the app (the helper provides its own messages)
    public static let helperCouldNotStart = "The app is damaged: its build engine could not be started. Download it again."
    public static let helperStoppedUnexpectedly = "The build engine stopped unexpectedly."
    public static let helperTooOld = "This copy of the app is incomplete or out of date. Download it again."
    public static let permissionFailed = "macOS did not give permission to write to the USB stick."
}
