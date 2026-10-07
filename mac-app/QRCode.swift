// 用 CoreImage 把字符串生成清晰二维码 NSImage（无第三方依赖）。
import AppKit
import CoreImage

enum QRCode {
    static func image(from string: String, sizePoints: CGFloat = 240) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(string.utf8), forKey: "inputMessage")
        filter.setValue("H", forKey: "inputCorrectionLevel")   // 高纠错
        guard let output = filter.outputImage else { return nil }
        // 整数倍放大，保持方块硬边缘，屏幕上不糊。
        let scale = max(1, (sizePoints / output.extent.width).rounded(.down))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let ctx = CIContext(options: nil)
        guard let cg = ctx.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
