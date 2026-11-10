import Foundation

// The 4-step flow (Choose → Destination → Progress → Done) as a pure value
// type: `reduce` applies an action and returns the side effect the controller
// must run. Everything here is unit-tested without processes or UI.

public enum FlowStep: Int, CaseIterable, Sendable {
    case choose, destination, progress, done
}

public enum BuildSource: Equatable, Sendable {
    case target(Catalog.Target)
    /// A `build-request.json` exported from iso.tunaos.org.
    case request(url: URL, summary: String, outputFilename: String?)
}

public enum Destination: Equatable, Sendable {
    case drive(Drive)
    case isoFile(URL)
}

public struct Job: Equatable, Sendable {
    public var source: BuildSource
    public var destination: Destination

    public init(source: BuildSource, destination: Destination) {
        self.source = source
        self.destination = destination
    }

    public var writesDrive: Bool {
        if case .drive = destination { return true }
        return false
    }

    public func buildArguments(output: String) -> [String] {
        switch source {
        case .target(let target):
            return ["build", "--target", target.id, "--out", output]
        case .request(let url, _, _):
            return ["build", "--request", url.path, "--out", output]
        }
    }

    public static func writeArguments(iso: String, drive: Drive) -> [String] {
        ["write", "--iso", iso, "--device", drive.id]
    }
}

public enum ProgressStage: Equatable, Sendable {
    case preparing, downloading, building, waitingForPermission, writing, verifying

    public var label: String {
        switch self {
        case .preparing: return Strings.phasePreparing
        case .downloading: return Strings.phaseDownloading
        case .building: return Strings.phaseBuilding
        case .waitingForPermission: return Strings.phaseWaitingForPermission
        case .writing: return Strings.phaseWriting
        case .verifying: return Strings.phaseVerifying
        }
    }

    init(_ phase: HelperPhase) {
        switch phase {
        case .download: self = .downloading
        case .unpack, .overlay, .erofs, .esp, .iso: self = .building
        case .write: self = .writing
        case .verify: self = .verifying
        }
    }
}

public enum Outcome: Equatable, Sendable {
    case wroteDrive(Drive)
    case savedISO(URL)
    case failed(message: String)
}

public enum FlowAction: Equatable, Sendable {
    case reloadCatalog
    case catalogLoaded(Catalog)
    case catalogFailed(HelperFailure)
    case selectDesktop(String)
    case selectBase(String)
    case selectPlatform(String)
    case openRequest(BuildSource)
    case continueToDestination
    case back
    case drivesUpdated([Drive])
    case drivesFailed(String)
    case selectDrive(String?)
    case requestErase
    case dismissErase
    case confirmErase
    case saveISO(URL)
    case helperEvent(HelperEvent)
    case appendLog(String)
    case awaitingPermission
    case finished(Outcome)
    case cancelled
    case tryAgain
    case startOver
}

public enum FlowEffect: Equatable, Sendable {
    case loadCatalog
    case startJob(Job)
}

/// Overall progress for the single progress bar: each phase owns a band of
/// 0…1 so the bar never jumps backwards between phases.
public enum OverallProgress {
    static let buildPhases: [HelperPhase] = [.unpack, .overlay, .erofs, .esp, .iso]

    public static func band(for phase: HelperPhase, writesDrive: Bool) -> ClosedRange<Double> {
        let download: ClosedRange<Double> = writesDrive ? 0...0.40 : 0...0.60
        let build: ClosedRange<Double> = writesDrive ? 0.40...0.65 : 0.60...1.0
        switch phase {
        case .download:
            return download
        case .write:
            return 0.65...0.92
        case .verify:
            return 0.92...1.0
        default:
            let index = Double(buildPhases.firstIndex(of: phase) ?? 0)
            let width = (build.upperBound - build.lowerBound) / Double(buildPhases.count)
            let lower = build.lowerBound + index * width
            return lower...(lower + width)
        }
    }

    public static func fraction(_ event: ProgressEvent, writesDrive: Bool) -> Double? {
        guard let phase = event.knownPhase else { return nil }
        let band = band(for: phase, writesDrive: writesDrive)
        var inPhase = 0.0
        if let current = event.current, let total = event.total, total > 0 {
            inPhase = min(max(Double(current) / Double(total), 0), 1)
        }
        return band.lowerBound + (band.upperBound - band.lowerBound) * inPhase
    }
}

public struct FlowState: Equatable, Sendable {
    public var step: FlowStep = .choose

    // 1. Choose
    public var catalog: Catalog?
    public var catalogError: HelperFailure?
    public var loadingCatalog = false
    public var platform: String
    public var desktopID: String?
    public var baseID: String?
    public var request: BuildSource?

    // 2. Destination
    public var drives: [Drive] = []
    public var drivesError: String?
    public var selectedDriveID: String?
    public var pendingErase: Drive?
    public var notice: String?

    // 3. Progress
    public var job: Job?
    public var stage: ProgressStage = .preparing
    /// nil = indeterminate.
    public var fraction: Double?
    public var bytesDone: Int64?
    public var bytesTotal: Int64?

    // 4. Done
    public var outcome: Outcome?
    /// Helper log for "Show details" (stderr + `log` events of the last job).
    public var log = ""

    /// macOS cannot boot these images (Apple Silicon) or is the wrong place to
    /// run them, so the stick is for a PC: default to x86-64 rather than the
    /// Mac's own architecture. ARM targets stay reachable under More options.
    public init(preferredPlatform: String = "linux/amd64") {
        platform = preferredPlatform
    }

    // MARK: Derived

    private func targets(desktop: String? = nil, base: String? = nil, platform: String? = nil) -> [Catalog.Target] {
        (catalog?.targets ?? []).filter {
            (desktop == nil || $0.desktop == desktop)
                && (base == nil || $0.base == base)
                && (platform == nil || $0.platform == platform)
        }
    }

    public var availableDesktops: [Catalog.Desktop] {
        let ids = Set(targets(platform: platform).map(\.desktop))
        return (catalog?.desktops ?? []).filter { ids.contains($0.id) }
    }

    public var availableBases: [Catalog.Base] {
        guard let desktopID else { return [] }
        let ids = Set(targets(desktop: desktopID, platform: platform).map(\.base))
        return (catalog?.bases ?? []).filter { ids.contains($0.id) }
    }

    public var availablePlatforms: [String] {
        let all = Set(targets(desktop: desktopID).map(\.platform))
        return all.sorted { a, b in
            // x86-64 first, then alphabetical.
            (a.hasPrefix("linux/amd64") ? 0 : 1, a) < (b.hasPrefix("linux/amd64") ? 0 : 1, b)
        }
    }

    public var selectedTarget: Catalog.Target? {
        guard let desktopID, let baseID else { return nil }
        let matches = targets(desktop: desktopID, base: baseID, platform: platform)
        return matches.first(where: \.isStandardGeneric) ?? matches.first
    }

    public var source: BuildSource? {
        request ?? selectedTarget.map(BuildSource.target)
    }

    public var selectedDrive: Drive? {
        drives.first { $0.id == selectedDriveID }
    }

    public var defaultISOFilename: String {
        switch source {
        case .request(_, _, let name?):
            return name
        case .target(let t):
            let arch = t.platform.split(separator: "/").dropFirst().first.map(String.init) ?? "amd64"
            return "tunaos-\(t.base)-\(t.desktop)-\(arch).iso"
        default:
            return "tunaos.iso"
        }
    }

    private var defaultParts: (base: String?, desktop: String?) {
        guard let id = catalog?.defaultTarget else { return (nil, nil) }
        let parts = id.split(separator: ":", maxSplits: 2).map(String.init)
        return (parts.first, parts.count > 1 ? parts[1] : nil)
    }

    // MARK: Reducer

    private mutating func resolveSelection() {
        if availableDesktops.isEmpty, let first = catalog?.targets.first(where: \.isStandardGeneric) ?? catalog?.targets.first {
            platform = first.platform
        }
        let desktops = availableDesktops.map(\.id)
        if desktopID == nil || !desktops.contains(desktopID!) {
            let preferred = defaultParts.desktop
            desktopID = desktops.contains(preferred ?? "") ? preferred : desktops.first
        }
        let bases = availableBases.map(\.id)
        if baseID == nil || !bases.contains(baseID!) {
            let preferred = defaultParts.base
            baseID = bases.contains(preferred ?? "") ? preferred : bases.first
        }
    }

    private mutating func resetProgress() {
        stage = .preparing
        fraction = nil
        bytesDone = nil
        bytesTotal = nil
        log = ""
        outcome = nil
        notice = nil
    }

    @discardableResult
    public mutating func reduce(_ action: FlowAction) -> FlowEffect? {
        switch action {
        case .reloadCatalog:
            loadingCatalog = true
            catalogError = nil
            return .loadCatalog

        case .catalogLoaded(let loaded):
            loadingCatalog = false
            catalogError = nil
            catalog = loaded
            resolveSelection()

        case .catalogFailed(let failure):
            loadingCatalog = false
            catalogError = failure

        case .selectDesktop(let id):
            guard availableDesktops.contains(where: { $0.id == id }) else { return nil }
            desktopID = id
            resolveSelection()

        case .selectBase(let id):
            guard availableBases.contains(where: { $0.id == id }) else { return nil }
            baseID = id

        case .selectPlatform(let id):
            guard availablePlatforms.contains(id) else { return nil }
            platform = id
            resolveSelection()

        case .openRequest(let source):
            guard step == .choose else { return nil }
            request = source
            step = .destination
            notice = nil

        case .continueToDestination:
            guard step == .choose, source != nil else { return nil }
            step = .destination
            notice = nil

        case .back:
            switch step {
            case .destination:
                step = .choose
                request = nil
                pendingErase = nil
            case .done:
                step = .choose
                request = nil
                outcome = nil
                job = nil
            case .choose, .progress:
                break
            }

        case .drivesUpdated(let list):
            drives = list
            drivesError = nil
            if let id = selectedDriveID, !list.contains(where: { $0.id == id }) {
                selectedDriveID = nil
            }
            if selectedDriveID == nil, list.count == 1 {
                selectedDriveID = list[0].id
            }
            if let pending = pendingErase, !list.contains(pending) {
                // Unplugged or changed while the confirmation was open.
                pendingErase = nil
            }

        case .drivesFailed(let message):
            drivesError = message

        case .selectDrive(let id):
            selectedDriveID = id.flatMap { id in drives.contains { $0.id == id } ? id : nil }

        case .requestErase:
            guard step == .destination, let drive = selectedDrive, source != nil else { return nil }
            pendingErase = drive

        case .dismissErase:
            pendingErase = nil

        case .confirmErase:
            guard step == .destination, let drive = pendingErase, let source else { return nil }
            pendingErase = nil
            return start(Job(source: source, destination: .drive(drive)))

        case .saveISO(let url):
            guard step == .destination, let source else { return nil }
            return start(Job(source: source, destination: .isoFile(url)))

        case .helperEvent(let event):
            guard step == .progress, let job else { return nil }
            switch event {
            case .progress(let progress):
                guard let phase = progress.knownPhase else { return nil }
                stage = ProgressStage(phase)
                if let value = OverallProgress.fraction(progress, writesDrive: job.writesDrive) {
                    fraction = max(fraction ?? 0, value)
                }
                if progress.unit == "bytes" {
                    bytesDone = progress.current
                    bytesTotal = progress.total
                } else {
                    bytesDone = nil
                    bytesTotal = nil
                }
            case .log(let entry):
                log += "[\(entry.level ?? "info")] \(entry.message)\n"
            case .error(let error):
                log += "[error:\(error.kind)] \(error.message)\n"
            default:
                break
            }

        case .appendLog(let text):
            log += text

        case .awaitingPermission:
            guard step == .progress else { return nil }
            stage = .waitingForPermission
            bytesDone = nil
            bytesTotal = nil

        case .finished(let result):
            guard step == .progress else { return nil }
            outcome = result
            step = .done

        case .cancelled:
            guard step == .progress else { return nil }
            step = .destination
            job = nil
            notice = Strings.cancelledNotice

        case .tryAgain:
            guard step == .done else { return nil }
            step = .destination
            outcome = nil
            job = nil

        case .startOver:
            step = .choose
            request = nil
            outcome = nil
            job = nil
            notice = nil
        }
        return nil
    }

    private mutating func start(_ newJob: Job) -> FlowEffect {
        resetProgress()
        job = newJob
        step = .progress
        return .startJob(newJob)
    }
}

/// Reads just enough of a build-request.json to show what it builds. The
/// helper validates the full request.
public enum BuildRequestFile {
    private struct Summary: Decodable {
        var schemaVersion: Int
        var image: String
        var options: Options?
        struct Options: Decodable { var outputFilename: String? }
    }

    public static func load(_ url: URL) throws -> BuildSource {
        let data = try Data(contentsOf: url)
        guard let summary = try? JSONDecoder().decode(Summary.self, from: data),
              summary.schemaVersion == 1,
              !summary.image.trimmingCharacters(in: .whitespaces).isEmpty
        else {
            throw HelperFailure(message: Strings.requestUnreadable, details: url.path)
        }
        let image = summary.image.split(separator: "/").last.map(String.init) ?? summary.image
        return .request(url: url, summary: image, outputFilename: summary.options?.outputFilename)
    }
}

public enum Format {
    public static func bytes(_ count: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        formatter.allowsNonnumericFormatting = false // "0 KB", not "Zero KB"
        return formatter.string(fromByteCount: count)
    }
}
