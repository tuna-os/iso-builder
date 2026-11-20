import Foundation
@testable import MediaWriterCore
import XCTest

final class LaunchLinkTests: XCTestCase {
    private func url(_ string: String) -> URL { URL(string: string)! }

    func testValidTargetIDs() throws {
        for id in ["yellowfin:gnome:linux/amd64", "albacore:gnome-hwe:linux/amd64/v2", "flounder-sid:xfce:linux/arm64"] {
            XCTAssertEqual(try LaunchLink.targetID(id), id)
        }
    }

    func testInvalidTargetIDs() {
        for id in ["", "yellowfin", "yellowfin:gnome", "yellowfin:gnome:linux", "Yellowfin:gnome:linux/amd64",
                   "yellowfin:gnome:linux/amd64 ", "yellowfin:gnome:linux/amd64\n", "--fake-helper",
                   "../../etc:passwd:linux/amd64", "a:b:c/d:e"] {
            XCTAssertThrowsError(try LaunchLink.targetID(id), id) {
                XCTAssertEqual($0 as? LaunchLink.Failure, .invalidTargetID, id)
            }
        }
    }

    func testURLEncodedLink() throws {
        XCTAssertEqual(
            try LaunchLink.targetID(from: url("tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64")),
            "yellowfin:gnome:linux/amd64")
        XCTAssertEqual(
            try LaunchLink.targetID(from: url("tunaos-media-writer://build?target=albacore%3Agnome-hwe%3Alinux%2Famd64%2Fv2")),
            "albacore:gnome-hwe:linux/amd64/v2")
    }

    func testUnencodedTrailingSlashAndCase() throws {
        for link in ["tunaos-media-writer://build?target=yellowfin:gnome:linux/amd64",
                     "tunaos-media-writer://build/?target=yellowfin%3Agnome%3Alinux%2Famd64",
                     "TUNAOS-MEDIA-WRITER://BUILD?target=yellowfin%3Agnome%3Alinux%2Famd64"] {
            XCTAssertEqual(try LaunchLink.targetID(from: url(link)), "yellowfin:gnome:linux/amd64", link)
        }
    }

    func testRefusedLinks() {
        let cases: [(String, LaunchLink.Failure)] = [
            ("https://iso.tunaos.org/?target=yellowfin%3Agnome%3Alinux%2Famd64", .notALink),
            ("file:///Users/u/build-request.json", .notALink),
            ("tunaos-media-writer://write?target=yellowfin%3Agnome%3Alinux%2Famd64", .unknownAction),
            ("tunaos-media-writer://build/extra?target=yellowfin%3Agnome%3Alinux%2Famd64", .unknownAction),
            ("tunaos-media-writer://build", .missingTarget),
            ("tunaos-media-writer://build?target=", .missingTarget),
            ("tunaos-media-writer://build?target=a%3Ab%3Alinux%2Famd64&target=c%3Ad%3Alinux%2Famd64", .missingTarget),
            ("tunaos-media-writer://build?target=not-a-target", .invalidTargetID),
            ("tunaos-media-writer://build?target=yellowfin%3Agnome%3Alinux%2Famd64%0A", .invalidTargetID),
        ]
        for (link, expected) in cases {
            XCTAssertThrowsError(try LaunchLink.targetID(from: url(link)), link) {
                XCTAssertEqual($0 as? LaunchLink.Failure, expected, link)
            }
        }
    }
}
