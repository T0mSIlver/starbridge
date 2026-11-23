// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "StarbridgeProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "StarbridgeProtocol", targets: ["StarbridgeProtocol"]),
    ],
    dependencies: [
        // The last tag, 0.9.1, is from 2020; this commit ships
        // libsodium 1.0.22 for Apple platforms and links the system libsodium elsewhere.
        .package(url: "https://github.com/jedisct1/swift-sodium", revision: "19d6edbb70bce36891993518cd399a043153007a"),
    ],
    targets: [
        .target(
            name: "StarbridgeProtocol",
            dependencies: [.product(name: "Clibsodium", package: "swift-sodium")]
        ),
        .testTarget(
            name: "StarbridgeProtocolTests",
            dependencies: ["StarbridgeProtocol"]
        ),
    ]
)
