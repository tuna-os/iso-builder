import AppKit
import MediaWriterCore
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Root

struct RootView: View {
    @EnvironmentObject private var controller: FlowController

    var body: some View {
        VStack(spacing: 0) {
            StepIndicator(current: controller.state.step)
                .padding(.vertical, 14)
            Divider()
            Group {
                switch controller.state.step {
                case .choose: ChooseView()
                case .destination: DestinationView()
                case .progress: ProgressStepView()
                case .done: DoneView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct StepIndicator: View {
    let current: FlowStep

    private func title(_ step: FlowStep) -> String {
        switch step {
        case .choose: return Strings.stepChoose
        case .destination: return Strings.stepDestination
        case .progress: return Strings.stepProgress
        case .done: return Strings.stepDone
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            ForEach(FlowStep.allCases, id: \.self) { step in
                if step != .choose {
                    Rectangle()
                        .fill(step.rawValue <= current.rawValue ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 36, height: 2)
                }
                HStack(spacing: 6) {
                    ZStack {
                        Circle()
                            .fill(step.rawValue <= current.rawValue ? Color.accentColor : Color.secondary.opacity(0.2))
                            .frame(width: 22, height: 22)
                        if step.rawValue < current.rawValue {
                            Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white)
                        } else {
                            Text("\(step.rawValue + 1)").font(.caption.bold())
                                .foregroundStyle(step == current ? Color.white : Color.secondary)
                        }
                    }
                    Text(title(step))
                        .font(.callout.weight(step == current ? .semibold : .regular))
                        .foregroundStyle(step == current ? Color.primary : Color.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// Bottom button row shared by all steps.
struct ActionBar<Leading: View, Trailing: View>: View {
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 12) {
                leading
                Spacer()
                trailing
            }
            .padding(16)
        }
    }
}

struct StepHeader: View {
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title.weight(.semibold))
            if let subtitle {
                Text(subtitle).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 1. Choose

struct ChooseView: View {
    @EnvironmentObject private var controller: FlowController
    @State private var importing = false
    @State private var importError: String?
    @State private var showCatalogDetails = false

    private var state: FlowState { controller.state }

    var body: some View {
        VStack(spacing: 0) {
            if state.catalog == nil {
                catalogPlaceholder
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        StepHeader(title: Strings.chooseTitle, subtitle: Strings.chooseSubtitle)
                        desktopGrid
                        options
                    }
                    .padding(24)
                }
            }
            ActionBar {
                Button(Strings.openRequestButton) { importing = true }
                    .disabled(state.catalog == nil && state.catalogError == nil)
            } trailing: {
                Button(Strings.continueButton) { controller.send(.continueToDestination) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.source == nil)
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                controller.send(.openRequest(try BuildRequestFile.load(try result.get())))
            } catch let failure as HelperFailure {
                importError = failure.message
            } catch {
                importError = error.localizedDescription
            }
        }
        .alert(Strings.requestUnreadable, isPresented: Binding(
            get: { importError != nil }, set: { if !$0 { importError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(importError ?? "")
        }
    }

    @ViewBuilder private var catalogPlaceholder: some View {
        VStack(spacing: 14) {
            Spacer()
            if let failure = state.catalogError {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
                Text(Strings.catalogFailedTitle).font(.title2.weight(.semibold))
                Text(failure.message).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button(Strings.retryButton) { controller.send(.reloadCatalog) }
                    .buttonStyle(.borderedProminent)
                DetailsDisclosure(isExpanded: $showCatalogDetails, text: failure.details)
                    .frame(maxWidth: 520)
            } else {
                ProgressView()
                Text(Strings.loadingCatalog).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    private var desktopGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 14)], spacing: 14) {
            ForEach(state.availableDesktops) { desktop in
                DesktopCard(desktop: desktop, selected: desktop.id == state.desktopID) {
                    controller.send(.selectDesktop(desktop.id))
                }
            }
        }
    }

    @ViewBuilder private var options: some View {
        Form {
            Picker(Strings.baseLabel, selection: Binding(
                get: { state.baseID ?? "" },
                set: { controller.send(.selectBase($0)) })
            ) {
                ForEach(state.availableBases) { base in
                    Text(base.label).tag(base.id)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 460)

            if state.availablePlatforms.count > 1 {
                DisclosureGroup(Strings.moreOptions) {
                    Picker(Strings.computerTypeLabel, selection: Binding(
                        get: { state.platform },
                        set: { controller.send(.selectPlatform($0)) })
                    ) {
                        ForEach(state.availablePlatforms, id: \.self) { platform in
                            Text(Strings.platformLabel(platform)).tag(platform)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    .padding(.top, 6)
                }
                .frame(maxWidth: 460, alignment: .leading)
            }
        }
    }
}

struct DesktopCard: View {
    let desktop: Catalog.Desktop
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(desktop.label).font(.headline)
                    Spacer()
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                        .font(.title3)
                }
                Text(desktop.description ?? "")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .topLeading)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(selected ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(selected ? Color.accentColor : Color.secondary.opacity(0.25), lineWidth: selected ? 2 : 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - 2. Destination

struct DestinationView: View {
    @EnvironmentObject private var controller: FlowController

    private var state: FlowState { controller.state }

    private var sourceSummary: String {
        switch state.source {
        case .request(_, let summary, _)?:
            return "\(Strings.fromRequestLabel): \(summary)"
        case .target(let target)?:
            let desktop = state.catalog?.desktops.first { $0.id == target.desktop }?.label ?? target.desktop
            let base = state.catalog?.bases.first { $0.id == target.base }?.label ?? target.base
            return "\(desktop) · \(base) · \(Strings.platformLabel(target.platform))"
        case nil:
            return ""
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                StepHeader(title: Strings.destinationTitle, subtitle: Strings.destinationSubtitle)
                Label(sourceSummary, systemImage: "shippingbox")
                    .foregroundStyle(.secondary)
                if let notice = state.notice {
                    Label(notice, systemImage: "info.circle")
                        .foregroundStyle(.orange)
                }
                driveList
                if let error = state.drivesError {
                    Text(error).font(.callout).foregroundStyle(.red)
                }
            }
            .padding(24)

            ActionBar {
                Button(Strings.backButton) { controller.send(.back) }
            } trailing: {
                Button(Strings.saveISOButton, action: saveISO)
                Button(Strings.writeButton) { controller.send(.requestErase) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(state.selectedDrive == nil)
            }
        }
        .confirmationDialog(
            eraseTitle,
            isPresented: Binding(
                get: { controller.state.pendingErase != nil },
                set: { if !$0 { controller.send(.dismissErase) } }),
            titleVisibility: .visible
        ) {
            Button(Strings.eraseButton, role: .destructive) { controller.send(.confirmErase) }
            Button(Strings.cancelButton, role: .cancel) { controller.send(.dismissErase) }
        } message: {
            Text(Strings.eraseMessage)
        }
    }

    private var eraseTitle: String {
        guard let drive = state.pendingErase else { return "" }
        return Strings.eraseTitle(name: drive.name, size: Format.bytes(drive.sizeBytes))
    }

    @ViewBuilder private var driveList: some View {
        if state.drives.isEmpty {
            HStack(spacing: 12) {
                ProgressView().controlSize(.small)
                Text(Strings.noDrives).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
        } else {
            List(state.drives, selection: Binding(
                get: { controller.state.selectedDriveID },
                set: { controller.send(.selectDrive($0)) })
            ) { drive in
                HStack(spacing: 12) {
                    Image(systemName: drive.bus == "sd" ? "sdcard.fill" : "externaldrive.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(drive.name).font(.headline)
                        Text(Format.bytes(drive.sizeBytes)).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
                .tag(drive.id)
            }
            .listStyle(.bordered(alternatesRowBackgrounds: false))
            .frame(minHeight: 180)
        }
    }

    private func saveISO() {
        let panel = NSSavePanel()
        panel.message = Strings.savePanelMessage
        panel.nameFieldStringValue = state.defaultISOFilename
        panel.allowedContentTypes = [UTType(filenameExtension: "iso") ?? .diskImage]
        panel.canCreateDirectories = true
        let handle: (NSApplication.ModalResponse) -> Void = { response in
            if response == .OK, let url = panel.url {
                controller.send(.saveISO(url))
            }
        }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(panel.runModal())
        }
    }
}

// MARK: - 3. Progress

struct ProgressStepView: View {
    @EnvironmentObject private var controller: FlowController

    private var state: FlowState { controller.state }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 18) {
                StepHeader(
                    title: state.job?.writesDrive == false ? Strings.progressTitleISO : Strings.progressTitleUSB,
                    subtitle: nil)
                Spacer()
                Text(state.stage.label).font(.title2.weight(.medium))
                if let fraction = state.fraction, state.stage != .waitingForPermission {
                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                } else {
                    ProgressView()
                        .progressViewStyle(.linear)
                }
                HStack {
                    if let done = state.bytesDone, let total = state.bytesTotal, total > 0 {
                        Text(Strings.bytesProgress(current: Format.bytes(done), total: Format.bytes(total)))
                    }
                    Spacer()
                    if let fraction = state.fraction, state.stage != .waitingForPermission {
                        Text(fraction.formatted(.percent.precision(.fractionLength(0))))
                    }
                }
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
                if state.stage == .waitingForPermission {
                    Label(Strings.permissionHint, systemImage: "lock")
                        .foregroundStyle(.secondary)
                } else if state.job?.writesDrive == true {
                    Label(Strings.keepPluggedIn, systemImage: "bolt.horizontal")
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(24)

            ActionBar {
                EmptyView()
            } trailing: {
                Button(Strings.cancelButton) { controller.cancel() }
                    .keyboardShortcut(.cancelAction)
            }
        }
    }
}

// MARK: - 4. Done

struct DoneView: View {
    @EnvironmentObject private var controller: FlowController
    @EnvironmentObject private var uiState: UIState

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 14) {
                Spacer()
                switch controller.state.outcome {
                case .wroteDrive?:
                    icon("checkmark.circle.fill", .green)
                    Text(Strings.doneTitleUSB).font(.title.weight(.semibold))
                    Text(Strings.doneMessageUSB).multilineTextAlignment(.center)
                    Link(Strings.installDocsLink, destination: Strings.installDocsURL)
                case .savedISO(let url)?:
                    icon("checkmark.circle.fill", .green)
                    Text(Strings.doneTitleISO).font(.title.weight(.semibold))
                    Text(url.lastPathComponent).font(.callout.monospaced()).foregroundStyle(.secondary)
                    Text(Strings.doneMessageISO).multilineTextAlignment(.center)
                    HStack(spacing: 16) {
                        Button(Strings.showInFinder) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                        Link(Strings.installDocsLink, destination: Strings.installDocsURL)
                    }
                case .failed(let message)?:
                    icon("exclamationmark.triangle.fill", .orange)
                    Text(Strings.failedTitle).font(.title.weight(.semibold))
                    Text(message).multilineTextAlignment(.center).frame(maxWidth: 520)
                    DetailsDisclosure(isExpanded: $uiState.showDetails, text: controller.state.log)
                        .frame(maxWidth: 560)
                case nil:
                    EmptyView()
                }
                Spacer()
            }
            .padding(24)
            .frame(maxWidth: .infinity)

            ActionBar {
                Button(Strings.startOver) {
                    uiState.showDetails = false
                    controller.send(.startOver)
                }
            } trailing: {
                if case .failed? = controller.state.outcome {
                    Button(Strings.tryAgain) {
                        uiState.showDetails = false
                        controller.send(.tryAgain)
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                } else {
                    Button(Strings.quitButton) { NSApp.terminate(nil) }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    private func icon(_ name: String, _ color: Color) -> some View {
        Image(systemName: name).font(.system(size: 54)).foregroundStyle(color)
    }
}

struct DetailsDisclosure: View {
    @Binding var isExpanded: Bool
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Button(isExpanded ? Strings.hideDetails : Strings.showDetails) { isExpanded.toggle() }
                .buttonStyle(.link)
            if isExpanded {
                ScrollView {
                    Text(text.isEmpty ? Strings.noDetails : text)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(height: 150)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3)))
            }
        }
    }
}
