// starbridge-widgets: writes the widget's snapshot, read from stdin, into the App Group container
// and asks WidgetKit to redraw. The app runs it from Contents/MacOS (src/widgets.ts): WidgetCenter
// is Swift only, and acts for the app whose bundle runs it.

import Foundation
import WidgetKit

let group = CommandLine.arguments.dropFirst().first ?? ""
guard !group.isEmpty, let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
    FileHandle.standardError.write("no App Group container for \(group)\n".data(using: .utf8)!)
    exit(1)
}
let data = FileHandle.standardInput.readDataToEndOfFile()
do {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try data.write(to: dir.appendingPathComponent("widgets.json"), options: .atomic)
} catch {
    FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
    exit(1)
}
WidgetCenter.shared.reloadAllTimelines()
