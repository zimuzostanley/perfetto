/*
 * Copyright (C) 2026 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package dev.perfetto.sdk;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.Arrays;
import javax.imageio.ImageIO;

/**
 * Generates a test trace with synthetic screenshot events for filmstrip
 * visualization testing.
 *
 * Each screenshot is a colored JPEG with a frame number overlay. The trace
 * can be loaded in the Perfetto UI to test the filmstrip track renderer.
 *
 * Usage: java GenerateScreenshotTrace [output.pb] [num_frames] [fps]
 */
public class GenerateScreenshotTrace {
    // TracePacket fields
    static final int TP_TIMESTAMP = 8;
    static final int TP_CLOCK_ID = 58;
    static final int TP_SEQ_ID = 10;
    static final int TP_SEQ_FLAGS = 13;
    static final int TP_TRACK_EVENT = 11;
    static final int TP_TRACK_DESCRIPTOR = 60;

    // TrackDescriptor fields
    static final int TD_UUID = 1;
    static final int TD_NAME = 2;

    // TrackEvent fields
    static final int TE_TYPE = 9;
    static final int TE_TRACK_UUID = 11;
    static final int TE_NAME = 23;
    static final int TE_CATEGORIES = 22;
    static final int TE_DEBUG_ANNOTATIONS = 4;

    // DebugAnnotation fields
    static final int DA_NAME = 10;
    static final int DA_BYTES_VALUE = 15; // proto_value for bytes

    // TrackEvent type
    static final int TYPE_INSTANT = 3;

    // sequence_flags
    static final int SEQ_CLEARED = 1;
    static final int SEQ_NEEDS = 2;

    static final long TRACK_UUID = 99999;

    public static void main(String[] args) throws Exception {
        String outputPath = args.length > 0 ? args[0] : "/tmp/screenshot_trace.pb";
        int numFrames = args.length > 1 ? Integer.parseInt(args[1]) : 60;
        int fps = args.length > 2 ? Integer.parseInt(args[2]) : 30;
        long intervalNs = 1_000_000_000L / fps;

        ProtoWriter trace = new ProtoWriter(numFrames * 40000); // ~30KB per frame
        ProtoWriter pkt = new ProtoWriter(40000);

        // Track descriptor.
        pkt.writeVarInt(TP_SEQ_ID, 1);
        int td = pkt.beginNested(TP_TRACK_DESCRIPTOR);
        pkt.writeVarInt(TD_UUID, TRACK_UUID);
        pkt.writeString(TD_NAME, "Screenshots");
        pkt.endNested(td);
        wrapPacket(trace, pkt);

        // Generate frames.
        for (int i = 0; i < numFrames; i++) {
            long ts = 1_000_000_000L + i * intervalNs;
            byte[] jpeg = generateFrame(i, numFrames);

            pkt.reset();
            pkt.writeVarInt(TP_TIMESTAMP, ts);
            pkt.writeVarInt(TP_CLOCK_ID, 6); // BUILTIN_CLOCK_BOOTTIME
            pkt.writeVarInt(TP_SEQ_ID, 1);
            pkt.writeVarInt(TP_SEQ_FLAGS,
                    i == 0 ? (SEQ_CLEARED | SEQ_NEEDS) : SEQ_NEEDS);

            int te = pkt.beginNested(TP_TRACK_EVENT);
            pkt.writeVarInt(TE_TYPE, TYPE_INSTANT);
            pkt.writeVarInt(TE_TRACK_UUID, TRACK_UUID);
            pkt.writeString(TE_NAME, "Screenshot");
            pkt.writeString(TE_CATEGORIES, "android_screenshot");

            // screenshot.jpg_image as a nested debug annotation
            // The key path is "screenshot.jpg_image" which the args parser
            // stores as a nested arg. We write it as a nested message with
            // bytes field matching the Screenshot proto layout:
            // TrackEvent.screenshot (field 50) { jpg_image (field 1) = bytes }
            pkt.endNested(te);

            // Write the screenshot field directly on the TrackEvent.
            // TrackEvent.screenshot = field 50, nested message.
            // We need to rewrite: the screenshot bytes go into
            // TrackEvent.screenshot.jpg_image (field 50 -> field 1).
            // But we already closed the track_event. Let me restructure.

            // Actually, let me write it properly: the screenshot is a field
            // on TrackEvent (field 50), containing jpg_image (field 1).
            pkt.reset();
            pkt.writeVarInt(TP_TIMESTAMP, ts);
            pkt.writeVarInt(TP_CLOCK_ID, 6);
            pkt.writeVarInt(TP_SEQ_ID, 1);
            pkt.writeVarInt(TP_SEQ_FLAGS,
                    i == 0 ? (SEQ_CLEARED | SEQ_NEEDS) : SEQ_NEEDS);

            te = pkt.beginNested(TP_TRACK_EVENT);
            pkt.writeVarInt(TE_TYPE, TYPE_INSTANT);
            pkt.writeVarInt(TE_TRACK_UUID, TRACK_UUID);
            pkt.writeString(TE_NAME, "Screenshot");
            pkt.writeString(TE_CATEGORIES, "android_screenshot");

            // TrackEvent.screenshot (field 50) = nested {
            //   jpg_image (field 1) = jpeg bytes
            // }
            int screenshot = pkt.beginNested(50);
            pkt.writeBytes(1, jpeg);
            pkt.endNested(screenshot);

            pkt.endNested(te);
            wrapPacket(trace, pkt);

            if (i % 10 == 0) {
                System.out.printf("Generated frame %d/%d (%d bytes JPEG)\n",
                        i + 1, numFrames, jpeg.length);
            }
        }

        byte[] traceBytes = Arrays.copyOf(trace.buffer(), trace.position());
        try (FileOutputStream fos = new FileOutputStream(outputPath)) {
            fos.write(traceBytes);
        }
        System.out.printf("Wrote %d frames (%d bytes) to %s\n",
                numFrames, traceBytes.length, outputPath);
    }

    static byte[] generateFrame(int frameNum, int totalFrames) throws Exception {
        int w = 320;
        int h = 180;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();

        // Background color cycling through hue.
        float hue = (float) frameNum / totalFrames;
        g.setColor(Color.getHSBColor(hue, 0.6f, 0.9f));
        g.fillRect(0, 0, w, h);

        // Frame number text.
        g.setColor(Color.WHITE);
        g.setFont(g.getFont().deriveFont(48f));
        String text = String.valueOf(frameNum);
        int textW = g.getFontMetrics().stringWidth(text);
        g.drawString(text, (w - textW) / 2, h / 2 + 16);

        // Timestamp bar at bottom.
        g.setColor(new Color(0, 0, 0, 128));
        g.fillRect(0, h - 20, w, 20);
        g.setColor(Color.WHITE);
        g.setFont(g.getFont().deriveFont(12f));
        g.drawString("Frame " + frameNum, 5, h - 5);

        g.dispose();

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "JPEG", baos);
        return baos.toByteArray();
    }

    static void wrapPacket(ProtoWriter trace, ProtoWriter pkt) {
        trace.writeBytes(1, pkt.buffer(), 0, pkt.position());
    }
}
