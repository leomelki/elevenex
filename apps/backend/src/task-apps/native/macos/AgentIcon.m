#import "Setup.h"

// The brand source contains four closed polygons. Read it from the signed
// bundle so setup and the draggable app use the same icon as the desktop.
int writeAgentIconset(NSString *directory) {
    NSURL *source = [NSBundle.mainBundle URLForResource:@"elevenex-logo" withExtension:@"svg"];
    NSXMLDocument *document = [[NSXMLDocument alloc] initWithContentsOfURL:source options:0 error:nil];
    NSArray *elements = [document nodesForXPath:@"//*[local-name()='path']" error:nil];
    NSRegularExpression *numbers = [NSRegularExpression regularExpressionWithPattern:@"-?[0-9]+(?:\\.[0-9]+)?" options:0 error:nil];
    if (elements.count != 4) return 2;
    for (NSNumber *pixels in @[@16, @32, @64, @128, @256, @512, @1024]) {
        NSInteger size = pixels.integerValue;
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:size pixelsHigh:size
            bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        NSAffineTransform *scale = [NSAffineTransform transform];
        [scale scaleBy:size / 1024.0]; [scale concat];
        [[NSColor colorWithSRGBRed:14/255.0 green:14/255.0 blue:13/255.0 alpha:1] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(64,64,896,896) xRadius:200 yRadius:200] fill];
        [[NSColor colorWithSRGBRed:225/255.0 green:229/255.0 blue:232/255.0 alpha:1] setFill];
        for (NSXMLElement *element in elements) {
            NSString *data = [[element attributeForName:@"d"] stringValue];
            NSArray<NSTextCheckingResult *> *matches = [numbers matchesInString:data options:0 range:NSMakeRange(0, data.length)];
            if (matches.count < 6 || matches.count % 2) return 2;
            NSBezierPath *path = [NSBezierPath bezierPath];
            for (NSUInteger i=0; i<matches.count; i+=2) {
                CGFloat x = [[data substringWithRange:matches[i].range] doubleValue];
                CGFloat y = [[data substringWithRange:matches[i+1].range] doubleValue];
                NSPoint point = NSMakePoint(190 + x * 644/410.0, 710 - y * 396/252.0);
                if (i == 0) [path moveToPoint:point]; else [path lineToPoint:point];
            }
            [path closePath]; [path fill];
        }
        [NSGraphicsContext restoreGraphicsState];
        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSString *file = [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"%ld.png", (long)size]];
        if (![png writeToFile:file atomically:YES]) return 2;
    }
    return 0;
}
