import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSSavePanel()
panel.title = "Chọn nơi lưu file"
panel.nameFieldStringValue = CommandLine.arguments[2]
panel.canCreateDirectories = true
app.activate(ignoringOtherApps: true)
if panel.runModal() == .OK, let url = panel.url {
    do {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        try data.write(to: url, options: .atomic)
        print("saved")
    } catch { fputs("Không lưu được file: \(error)\n", stderr); exit(1) }
} else { print("cancelled") }
