import Foundation

/// Links from iso.tunaos.org that open the app on a catalog target
/// (PROTOCOL.md, "Opening the app on a target"):
///
///     TunaOSMediaWriter --target yellowfin:gnome:linux/amd64
///     tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64
///
/// Only the form is checked here; whether the catalog offers the target is
/// `FlowAction.openTarget`'s decision.
public enum LaunchLink {
    public static let scheme = "tunaos-media-writer"
    public static let action = "build"

    public enum Failure: Error, Equatable {
        case notALink
        case unknownAction
        case missingTarget
        case invalidTargetID
        case invalidCell
        case invalidDigest
        case digestWithoutCell
    }

    /// base:desktop:os/arch[/variant], as the catalog's target ids are spelled.
    private static let targetPattern = try! NSRegularExpression(
        pattern: #"\A[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*:[a-z0-9]+(/[a-z0-9._-]+)+\z"#)

    /// The `--target` value, checked for the shape of a catalog target id.
    public static func targetID(_ value: String) throws -> String {
        let range = NSRange(value.startIndex..., in: value)
        guard targetPattern.firstMatch(in: value, range: range) != nil else {
            throw Failure.invalidTargetID
        }
        return value
    }

    /// The target id of a `tunaos-media-writer://build?target=ID` link.
    public static func targetID(from url: URL) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == scheme
        else { throw Failure.notALink }
        guard parts.host?.lowercased() == action, parts.path.isEmpty || parts.path == "/" else {
            throw Failure.unknownAction
        }
        let values = (parts.queryItems ?? []).filter { $0.name == "target" }.compactMap(\.value)
        guard values.count == 1, !values[0].isEmpty else { throw Failure.missingTarget }
        return try targetID(values[0])
    }

    // TODO(writer-665): not compiled on this host; the macOS CI job covers
    // it. Mirrors the tested Python parser in desktop/linux/launch.py.
    /// The optional `cell` and `digest` of a build link ("" when absent).
    ///
    /// A cell names the prepared installer image to fetch instead of
    /// building. A digest pins its manifest; the fetch fails if it differs.
    public static func cellAndDigest(from url: URL) throws -> (cell: String, digest: String) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == scheme
        else { throw Failure.notALink }
        let cells = (parts.queryItems ?? []).filter { $0.name == "cell" }.compactMap(\.value)
        let digests = (parts.queryItems ?? []).filter { $0.name == "digest" }.compactMap(\.value)
        guard cells.count <= 1, digests.count <= 1 else { throw Failure.invalidCell }
        let cell = cells.first ?? "", digest = digests.first ?? ""
        if cell.contains(where: \.isWhitespace) || cell.contains("?") || cell.contains("#") || cell.count > 1024 {
            throw Failure.invalidCell
        }
        if !digest.isEmpty {
            guard digest.hasPrefix("sha256:"),
                  digest.count == 7 + 64,
                  digest.dropFirst(7).allSatisfy({ $0.isHexDigit })
            else { throw Failure.invalidDigest }
            guard !cell.isEmpty else { throw Failure.digestWithoutCell }
        }
        return (cell, digest)
    }
}
