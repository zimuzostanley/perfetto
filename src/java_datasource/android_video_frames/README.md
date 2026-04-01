# Android Video Frames Data Source

## Overview

A Perfetto data source that captures screen frames as JPEG images at up to 60fps.
Frames are stored as `TrackEvent` slices with `Screenshot.jpg_image` bytes, reusing
the existing screenshot proto and trace processor infrastructure.

This data source lives in the Android tree (`frameworks/base`), not in this repo.
The Perfetto-side changes (filmstrip UI plugin, test trace generator) are already
done. This document specifies exactly what to build on the Android side.

## Architecture

```
Choreographer vsync
       ↓
ImageReader.onImageAvailable()  ← runs on SF vsync thread, must be fast
       ↓ acquireLatestImage() + post to background thread
       ↓
CompressionThread (HandlerThread)
       ├─ Lock HardwareBuffer for CPU read
       ├─ JPEG compress via libjpeg-turbo (NEON, ~3ms at 540p)
       ├─ ProtoWriter: encode TracePacket with TrackEvent.screenshot.jpg_image
       └─ commitPacket() → Perfetto shmem
```

## Files to create

All in `frameworks/base/services/core/java/com/android/server/wm/`:

### 1. `VideoFrameDataSource.java`

Extends `dev.perfetto.sdk.PerfettoDataSource` (the new high-performance SDK).

```java
public class VideoFrameDataSource extends PerfettoDataSource {
    static final VideoFrameDataSource INSTANCE = new VideoFrameDataSource();
    static { INSTANCE.register("android.video_frames"); }

    @Override
    protected void onStart(int instanceIndex) {
        VideoFrameTracing.INSTANCE.onStart(/* parse config for resolution, fps, quality */);
    }

    @Override
    protected void onStop(int instanceIndex) {
        VideoFrameTracing.INSTANCE.onStop();
    }
}
```

### 2. `VideoFrameTracing.java`

The capture engine. Modeled on `WindowTracingPerfetto`.

**onStart(config):**
1. Parse config: `resolution_scale` (default 0.5), `jpeg_quality` (default 60), `max_fps` (default 30)
2. Get display metrics: `DisplayManager.getDisplay(DEFAULT_DISPLAY)`
3. Create `ImageReader` at scaled resolution, format `PixelFormat.RGBA_8888`, maxImages=2
4. Create `VirtualDisplay` via `DisplayManager.createVirtualDisplay()`:
   - Name: `"perfetto-video-frames"`
   - Width/height: display size × resolution_scale
   - DPI: scaled accordingly
   - Surface: `imageReader.getSurface()`
   - Flags: `VIRTUAL_DISPLAY_FLAG_PUBLIC | VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR`
5. Start the compression `HandlerThread`
6. Set `ImageReader.OnImageAvailableListener` (runs on SF vsync thread):
   ```java
   reader.setOnImageAvailableListener(r -> {
       Image image = r.acquireLatestImage(); // drops stale frames
       if (image != null) {
           compressionHandler.post(() -> compressAndWrite(image));
       }
   }, sfHandler);
   ```

**compressAndWrite(image):**
1. Get `Image.Plane[0]` (RGBA data)
2. `HardwareBuffer hb = image.getHardwareBuffer(); hb.lock(...)` for CPU read
3. Compress to JPEG using `android.graphics.Bitmap.compress()` or JNI to libjpeg-turbo
4. Write TracePacket:
   ```java
   TraceContext ctx = VideoFrameDataSource.INSTANCE.trace();
   if (ctx == null) { image.close(); return; }
   ProtoWriter w = ctx.getWriter();
   w.writeVarInt(8, SystemClock.elapsedRealtimeNanos());  // timestamp
   w.writeVarInt(58, 6);  // clock_id = BOOTTIME
   w.writeVarInt(10, 1);  // trusted_packet_sequence_id
   w.writeVarInt(13, 2);  // sequence_flags = NEEDS_INCREMENTAL_STATE
   int te = w.beginNested(11);  // track_event
   w.writeVarInt(9, 3);   // type = INSTANT
   w.writeVarInt(11, TRACK_UUID);  // track_uuid
   w.writeString(23, "Screenshot");  // name
   w.writeString(22, "android_screenshot");  // categories
   int ss = w.beginNested(50);  // screenshot
   w.writeBytes(1, jpegBytes);  // jpg_image
   w.endNested(ss);
   w.endNested(te);
   ctx.commitPacket();
   ```
5. `image.close()` — releases the buffer back to ImageReader

**onStop():**
1. `imageReader.close()` — stops receiving frames
2. `virtualDisplay.release()`
3. Drain compression handler queue
4. Stop HandlerThread

## Key performance requirements

- **ImageReader callback must be fast**: only `acquireLatestImage()` + post. No blocking.
- **acquireLatestImage() drops stale frames**: if compression can't keep up, frames are skipped, not queued.
- **Compression thread is separate from SF thread**: never blocks composition.
- **shmem_size_hint**: use 4MB (4096KB) to accommodate ~130 frames of buffering at 30KB each.
- **Buffer exhausted policy**: `STALL_AND_ABORT` (matching LayerDataSource).

## Config proto

Add to `DataSourceConfig` in `protos/perfetto/config/`:

```proto
message VideoFrameConfig {
  optional float resolution_scale = 1;  // 0.0-1.0, default 0.5
  optional uint32 jpeg_quality = 2;     // 1-100, default 60
  optional uint32 max_fps = 3;          // default 30
}
```

## Trace config example

```proto
data_sources {
  config {
    name: "android.video_frames"
    video_frame_config {
      resolution_scale: 0.5
      jpeg_quality: 60
      max_fps: 30
    }
  }
}
```

## Permissions

Requires `CAPTURE_VIDEO_OUTPUT` (system-level) or running as shell UID. The data
source runs inside `system_server` as part of WindowManagerService, which has the
required permissions.

## Dependencies

- `dev.perfetto.sdk.PerfettoDataSource` (the new high-performance Java SDK from this repo)
- `android.hardware.display.DisplayManager`
- `android.media.ImageReader`
- `android.graphics.Bitmap` (for JPEG compression)

## Testing

Generate a test trace on the host:
```sh
java -cp <classpath> dev.perfetto.sdk.GenerateScreenshotTrace /tmp/test.pb 60 30
```

Load in Perfetto UI to verify the filmstrip track renders correctly.

On device:
```sh
perfetto -c - --txt <<EOF
buffers { size_kb: 32768 }
data_sources {
  config {
    name: "android.video_frames"
    video_frame_config {
      resolution_scale: 0.5
      jpeg_quality: 60
      max_fps: 30
    }
  }
}
duration_ms: 5000
EOF
```
