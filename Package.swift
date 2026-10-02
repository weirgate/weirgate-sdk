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
            path: "WeirgateKit/Sources/WeirgateKit",
            resources: [.process("Resources")]
        ),
        .target(
            name: "WeirgateStoreKit",
            dependencies: ["WeirgateKit"],
            path: "WeirgateKit/Sources/WeirgateStoreKit"
        ),
        .testTarget(
            name: "WeirgateKitTests",
            dependencies: ["WeirgateKit"],
            path: "WeirgateKit/Tests/WeirgateKitTests"
        ),
        .testTarget(
            name: "WeirgateStoreKitTests",
            dependencies: ["WeirgateKit", "WeirgateStoreKit"],
            path: "WeirgateKit/Tests/WeirgateStoreKitTests"
        )
    ]
)
