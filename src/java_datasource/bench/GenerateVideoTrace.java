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
 * Generates a test trace with VideoFrame packets for filmstrip testing.
 *
 * Usage: java GenerateVideoTrace [output.pb] [num_frames] [fps]
 */
public class GenerateVideoTrace {
    // TracePacket fields
    static final int TP_TIMESTAMP = 8;
    static final int TP_CLOCK_ID = 58;
    // VideoFrame is field 126 on TracePacket
    static final int TP_VIDEO_FRAME = 126;
    // VideoFrame fields
    static final int VF_FRAME_NUMBER = 1;
    static final int VF_JPG_IMAGE = 2;

    public static void main(String[] args) throws Exception {
        String output = args.length > 0 ? args[0] : "/tmp/video_trace.pb";
        int numFrames = args.length > 1 ? Integer.parseInt(args[1]) : 60;
        int fps = args.length > 2 ? Integer.parseInt(args[2]) : 30;
        long intervalNs = 1_000_000_000L / fps;

        ProtoWriter trace = new ProtoWriter(numFrames * 40000);
        ProtoWriter pkt = new ProtoWriter(40000);

        for (int i = 0; i < numFrames; i++) {
            long ts = 1_000_000_000L + i * intervalNs;
            byte[] jpeg = generateFrame(i, numFrames);

            pkt.reset();
            pkt.writeVarInt(TP_TIMESTAMP, ts);
            pkt.writeVarInt(TP_CLOCK_ID, 6);
            int vf = pkt.beginNested(TP_VIDEO_FRAME);
            pkt.writeVarInt(VF_FRAME_NUMBER, i);
            pkt.writeBytes(VF_JPG_IMAGE, jpeg);
            pkt.endNested(vf);

            // Wrap in Trace.packet (field 1)
            trace.writeBytes(1, pkt.buffer(), 0, pkt.position());

            if (i % 10 == 0) {
                System.out.printf("Frame %d/%d (%d bytes)\n",
                        i + 1, numFrames, jpeg.length);
            }
        }

        byte[] data = Arrays.copyOf(trace.buffer(), trace.position());
        try (FileOutputStream fos = new FileOutputStream(output)) {
            fos.write(data);
        }
        System.out.printf("Wrote %d frames (%d bytes) to %s\n",
                numFrames, data.length, output);
    }

    static byte[] generateFrame(int frameNum, int total) throws Exception {
        int w = 320, h = 180;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();

        float hue = (float) frameNum / total;
        g.setColor(Color.getHSBColor(hue, 0.6f, 0.9f));
        g.fillRect(0, 0, w, h);

        g.setColor(Color.WHITE);
        g.setFont(g.getFont().deriveFont(48f));
        String text = String.valueOf(frameNum);
        int tw = g.getFontMetrics().stringWidth(text);
        g.drawString(text, (w - tw) / 2, h / 2 + 16);

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
}
