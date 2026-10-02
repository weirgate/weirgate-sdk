// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "WeirgateKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "WeirgateKit", targets: ["WeirgateKit"]),
        .library(name: "WeirgateStoreKit", targets: ["WeirgateStoreKit"])
    ],
    targets: [
        .target(
            name: "WeirgateKit",
            resources: [.process("Resources")]
        ),
        .target(
            name: "WeirgateStoreKit",
            dependencies: ["WeirgateKit"]
        ),
        .testTarget(
            name: "WeirgateKitTests",
            dependencies: ["WeirgateKit"]
        ),
        .testTarget(
            name: "WeirgateStoreKitTests",
            dependencies: ["WeirgateKit", "WeirgateStoreKit"]
        )
    ]
)
