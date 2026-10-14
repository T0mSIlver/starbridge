// swift-tools-version:5.9
// The Needs you widget and its helper. build.sh builds them for the app; codeql-swift.yml builds
// this package the same way.
import PackageDescription

let package = Package(
  name: "StarbridgeWidgets",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "StarbridgeWidgets", targets: ["NeedsYou"]),
    .executable(name: "starbridge-widgets", targets: ["Reload"]),
  ],
  targets: [
    // An extension starts in NSExtensionMain, which finds the @main WidgetBundle.
    .executableTarget(
      name: "NeedsYou",
      swiftSettings: [.unsafeFlags(["-application-extension"])],
      linkerSettings: [
        .unsafeFlags([
          "-Xlinker", "-application_extension", "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain",
        ])
      ]
    ),
    .executableTarget(name: "Reload"),
  ]
)
