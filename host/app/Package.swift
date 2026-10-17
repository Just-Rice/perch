// swift-tools-version:5.9
// Perch.app, the Mac side of Perch: menu bar item, screen and sound capture, video/audio encoding, input, and the
// Node host process it starts. Builds with the Command Line Tools alone (no Xcode):
//   swift build -c release            (from host/app)
//   .build/release/Perch --selftest
// host/scripts/make-app.sh wraps the binary into build/Perch.app.
import PackageDescription

let package = Package(
    name: "Perch",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Perch", targets: ["Perch"]),
    ],
    targets: [
        // Pure logic with no capture or UI: IPC framing, JSON helpers, the key map and input planning.
        .target(
            name: "PerchCore",
            linkerSettings: [.linkedFramework("CoreGraphics")]
        ),
        // Screen/sound capture and encoding (ScreenCaptureKit, VideoToolbox, AudioToolbox) and the synthetic source.
        .target(
            name: "PerchMedia",
            dependencies: ["PerchCore"],
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("AppKit"),
                .linkedFramework("IOKit"), // waking a sleeping display before capturing it
            ]
        ),
        // The app itself: menu bar, host process, permissions, power, notifications, login item, self-test.
        .executableTarget(
            name: "Perch",
            dependencies: ["PerchCore", "PerchMedia"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("IOKit"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
    ]
)
