// An independent Syphon client for test/outputs.mjs: it reads a server the way
// OpenGL VJ apps do (Syphon's own SyphonOpenGLClient) and prints one line of JSON
// with the size and the colour at the centre of each quadrant of the picture.
// GL convention: texture row 0 is the BOTTOM of the picture.
//   syphon-probe <server name>              size and quadrant colours of the next frame
//   syphon-probe <server name> --absent     {"present": false} when no such server shows up
//   syphon-probe <server name> --fps <s>    new frames per second, counted for <s> seconds
#import <Foundation/Foundation.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl.h>
#import <Syphon/Syphon.h>

static NSDictionary *findServer(NSString *name, double seconds) {
  SyphonServerDirectory *dir = [SyphonServerDirectory sharedDirectory];
  for (double t = 0; t < seconds; t += 0.1) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    for (NSDictionary *d in dir.servers) if ([d[SyphonServerDescriptionNameKey] isEqualToString:name]) return d;
  }
  return nil;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc < 2) return 2;
    NSString *name = [NSString stringWithUTF8String:argv[1]];
    BOOL absent = argc > 2 && !strcmp(argv[2], "--absent");
    double fpsSeconds = argc > 3 && !strcmp(argv[2], "--fps") ? atof(argv[3]) : 0;
    NSDictionary *desc = findServer(name, absent ? 2 : 5);
    if (absent) { printf("{\"present\":%s}\n", desc ? "true" : "false"); return 0; }
    if (!desc) { printf("{\"error\":\"no server\"}\n"); return 1; }

    CGLPixelFormatAttribute attrs[] = { kCGLPFAAccelerated, kCGLPFAAllowOfflineRenderers, 0 };
    CGLPixelFormatObj pf; GLint n;
    CGLChoosePixelFormat(attrs, &pf, &n);
    CGLContextObj ctx;
    CGLCreateContext(pf, NULL, &ctx);
    CGLSetCurrentContext(ctx);
    SyphonOpenGLClient *client = [[SyphonOpenGLClient alloc] initWithServerDescription:desc context:ctx options:nil newFrameHandler:nil];
    if (fpsSeconds > 0) {
      int frames = -1; // the first one only says the stream is there
      NSDate *end = nil;
      for (NSDate *give = [NSDate dateWithTimeIntervalSinceNow:5]; !end || [end timeIntervalSinceNow] > 0;) {
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.002]];
        if (!client.hasNewFrame) { if (!end && [give timeIntervalSinceNow] < 0) break; continue; }
        (void)[client newFrameImage];
        if (++frames == 0) end = [NSDate dateWithTimeIntervalSinceNow:fpsSeconds];
      }
      printf("{\"fps\":%.1f}\n", end ? frames / fpsSeconds : 0.0);
      [client stop];
      return 0;
    }
    SyphonOpenGLImage *img = nil;
    for (int i = 0; i < 100 && !img; i++) {
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
      if (client.hasNewFrame) img = [client newFrameImage];
    }
    if (!img) { printf("{\"error\":\"no frame\"}\n"); return 1; }

    int w = img.textureSize.width, h = img.textureSize.height;
    unsigned char *px = malloc((size_t)w * h * 4);
    GLuint fbo;
    glGenFramebuffersEXT(1, &fbo);
    glBindFramebufferEXT(GL_FRAMEBUFFER_EXT, fbo);
    glFramebufferTexture2DEXT(GL_FRAMEBUFFER_EXT, GL_COLOR_ATTACHMENT0_EXT, GL_TEXTURE_RECTANGLE_ARB, img.textureName, 0);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px);
#define AT(x, y) px[((size_t)(y) * w + (x)) * 4], px[((size_t)(y) * w + (x)) * 4 + 1], px[((size_t)(y) * w + (x)) * 4 + 2]
    int top = h - 1 - h / 4, bottom = h / 4, left = w / 4, right = w - 1 - w / 4;
    printf("{\"app\":\"%s\",\"w\":%d,\"h\":%d,\"tl\":[%d,%d,%d],\"tr\":[%d,%d,%d],\"bl\":[%d,%d,%d],\"br\":[%d,%d,%d]}\n",
           [desc[SyphonServerDescriptionAppNameKey] UTF8String], w, h,
           AT(left, top), AT(right, top), AT(left, bottom), AT(right, bottom));
    [client stop];
  }
  return 0;
}
