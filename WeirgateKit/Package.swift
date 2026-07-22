// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "WeirgateKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "WeirgateKit", targets: ["WeirgateKit"])
    ],
    targets: [
        .target(
            name: "WeirgateKit",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "WeirgateKitTests",
            dependencies: ["WeirgateKit"]
        )
    ]
)
