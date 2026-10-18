import math
import struct
import zlib
import os

def make_png(width, height, rgba_data):
    """Encodes raw RGBA bytes into a valid PNG byte stream using standard library zlib."""
    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'

    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data)
    png += struct.pack('>I', len(ihdr_data)) + b'IHDR' + ihdr_data + struct.pack('>I', ihdr_crc)

    # IDAT chunk (scanlines with filter byte 0)
    scanlines = bytearray()
    row_bytes = width * 4
    for y in range(height):
        scanlines.append(0)  # filter: None
        start = y * row_bytes
        scanlines.extend(rgba_data[start:start + row_bytes])

    compressed = zlib.compress(bytes(scanlines), 9)
    idat_crc = zlib.crc32(b'IDAT' + compressed)
    png += struct.pack('>I', len(compressed)) + b'IDAT' + compressed + struct.pack('>I', idat_crc)

    # IEND chunk
    iend_crc = zlib.crc32(b'IEND')
    png += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', iend_crc)

    return png

def dist_segment(px, py, ax, ay, bx, by):
    """Calculates the minimum distance from point (px, py) to line segment (a, b)."""
    pax = px - ax
    pay = py - ay
    bax = bx - ax
    bay = by - ay
    h = max(0.0, min(1.0, (pax * bax + pay * bay) / (bax * bax + bay * bay + 1e-9)))
    dx = pax - bax * h
    dy = pay - bay * h
    return math.sqrt(dx * dx + dy * dy)

def dist_circle(px, py, cx, cy, r):
    dx = px - cx
    dy = py - cy
    return math.sqrt(dx * dx + dy * dy) - r

def render_omnilink_icon(size):
    """Renders the OmniLink icon at the given pixel resolution with 4x MSAA anti-aliasing."""
    rgba = bytearray(size * size * 4)

    # Subpixel sampling offsets for 4x MSAA
    samples = [
        (-0.25, -0.25),
        (0.25, -0.25),
        (-0.25, 0.25),
        (0.25, 0.25)
    ]

    for py in range(size):
        for px in range(size):
            accum_r, accum_g, accum_b, accum_a = 0.0, 0.0, 0.0, 0.0

            for sx, sy in samples:
                # Map to normalized space [-1.0, 1.0]
                nx = ((px + 0.5 + sx) / size) * 2.0 - 1.0
                ny = ((py + 0.5 + sy) / size) * 2.0 - 1.0

                # 1. Background Squircle Badge
                # Using superellipse (|x|^4.5 + |y|^4.5)^(1/4.5)
                squircle_dist = (abs(nx) ** 4.5 + abs(ny) ** 4.5) ** (1.0 / 4.5)
                badge_radius = 0.88
                badge_edge = 0.03

                if squircle_dist > badge_radius + badge_edge:
                    # Outside badge
                    continue

                # Alpha of badge edge
                badge_alpha = max(0.0, min(1.0, (badge_radius + badge_edge - squircle_dist) / badge_edge))

                # Background gradient: Deep slate-900 (15, 23, 42) to Midnight indigo (24, 27, 68)
                t_grad = (nx + ny + 1.4) / 2.8
                t_grad = max(0.0, min(1.0, t_grad))
                bg_r = 15.0 * (1.0 - t_grad) + 26.0 * t_grad
                bg_g = 23.0 * (1.0 - t_grad) + 32.0 * t_grad
                bg_b = 42.0 * (1.0 - t_grad) + 72.0 * t_grad

                # Subtle top glass highlight
                if ny < 0.0 and squircle_dist < badge_radius - 0.05:
                    highlight = max(0.0, -ny * 0.25 * (1.0 - abs(nx)))
                    bg_r = min(255.0, bg_r + highlight * 180.0)
                    bg_g = min(255.0, bg_g + highlight * 210.0)
                    bg_b = min(255.0, bg_b + highlight * 255.0)

                # Outer border rim (gradient from Cyan #38BDF8 to Violet #818CF8 to Emerald #34D399)
                rim_dist = abs(squircle_dist - badge_radius)
                rim_width = 0.035
                if rim_dist < rim_width:
                    rim_t = (nx + 1.0) * 0.5
                    rim_t = max(0.0, min(1.0, rim_t))
                    # Cyan to Emerald gradient
                    rim_r = 56.0 * (1.0 - rim_t) + 52.0 * rim_t
                    rim_g = 189.0 * (1.0 - rim_t) + 211.0 * rim_t
                    rim_b = 248.0 * (1.0 - rim_t) + 153.0 * rim_t
                    rim_intensity = (1.0 - rim_dist / rim_width) ** 1.5
                    bg_r = bg_r * (1.0 - rim_intensity) + rim_r * rim_intensity
                    bg_g = bg_g * (1.0 - rim_intensity) + rim_g * rim_intensity
                    bg_b = bg_b * (1.0 - rim_intensity) + rim_b * rim_intensity

                cur_r, cur_g, cur_b, cur_a = bg_r, bg_g, bg_b, badge_alpha

                # 2. Foreground: OmniLink Multi-Bond Glyph
                # Three inputs on left converging into forward turbo chevron on right
                # Nodes:
                # Top-Left: (-0.46, -0.38) [Cyan]
                # Mid-Left: (-0.56, 0.00) [Violet]
                # Bot-Left: (-0.46, 0.38) [Emerald]
                # Center Hub: (0.05, 0.00)
                # Apex Node: (0.48, 0.00) [Pure White / Cyan Turbo Apex]

                line_w = 0.08
                node_r = 0.12

                # Stream 1 (Top LAN link): (-0.46, -0.38) -> (0.05, 0.0)
                d_stream1 = dist_segment(nx, ny, -0.46, -0.38, 0.05, 0.0)
                # Stream 2 (Mid Wi-Fi link): (-0.56, 0.00) -> (0.05, 0.0)
                d_stream2 = dist_segment(nx, ny, -0.56, 0.00, 0.05, 0.0)
                # Stream 3 (Bot 5G link): (-0.46, 0.38) -> (0.05, 0.0)
                d_stream3 = dist_segment(nx, ny, -0.46, 0.38, 0.05, 0.0)

                # Accelerated Bond Channel (Forward Turbo Chevron):
                # Upper wing: (0.05, 0.0) -> (0.22, 0.26) -> (0.48, 0.0)
                # Lower wing: (0.05, 0.0) -> (0.22, -0.26) -> (0.48, 0.0)
                d_wing_up = dist_segment(nx, ny, 0.05, 0.0, 0.48, 0.0)

                # Nodes
                d_node_top = dist_circle(nx, ny, -0.46, -0.38, node_r)
                d_node_mid = dist_circle(nx, ny, -0.56, 0.00, node_r)
                d_node_bot = dist_circle(nx, ny, -0.46, 0.38, node_r)
                d_node_apex = dist_circle(nx, ny, 0.48, 0.00, node_r * 1.15)

                # Blend Stream 1 (Cyan #38BDF8)
                if d_stream1 < line_w:
                    intense = max(0.0, min(1.0, (line_w - d_stream1) / 0.02))
                    cur_r = cur_r * (1.0 - intense) + 56.0 * intense
                    cur_g = cur_g * (1.0 - intense) + 189.0 * intense
                    cur_b = cur_b * (1.0 - intense) + 248.0 * intense

                # Blend Stream 3 (Emerald #34D399)
                if d_stream3 < line_w:
                    intense = max(0.0, min(1.0, (line_w - d_stream3) / 0.02))
                    cur_r = cur_r * (1.0 - intense) + 52.0 * intense
                    cur_g = cur_g * (1.0 - intense) + 211.0 * intense
                    cur_b = cur_b * (1.0 - intense) + 153.0 * intense

                # Blend Stream 2 (Electric Violet #818CF8)
                if d_stream2 < line_w:
                    intense = max(0.0, min(1.0, (line_w - d_stream2) / 0.02))
                    cur_r = cur_r * (1.0 - intense) + 129.0 * intense
                    cur_g = cur_g * (1.0 - intense) + 140.0 * intense
                    cur_b = cur_b * (1.0 - intense) + 248.0 * intense

                # Blend Forward Turbo Link (Bright Sky Blue #38BDF8 to Emerald)
                if d_wing_up < line_w * 1.3:
                    intense = max(0.0, min(1.0, (line_w * 1.3 - d_wing_up) / 0.02))
                    cur_r = cur_r * (1.0 - intense) + 224.0 * intense
                    cur_g = cur_g * (1.0 - intense) + 242.0 * intense
                    cur_b = cur_b * (1.0 - intense) + 254.0 * intense

                # Draw Nodes with high-intensity glowing cores
                # Node Top (Cyan)
                if d_node_top < 0.0:
                    intense = max(0.0, min(1.0, -d_node_top / 0.02))
                    core = max(0.0, min(1.0, (-d_node_top - 0.04) / 0.02))
                    nr = 56.0 * (1.0 - core) + 240.0 * core
                    ng = 189.0 * (1.0 - core) + 250.0 * core
                    nb = 248.0 * (1.0 - core) + 255.0 * core
                    cur_r = cur_r * (1.0 - intense) + nr * intense
                    cur_g = cur_g * (1.0 - intense) + ng * intense
                    cur_b = cur_b * (1.0 - intense) + nb * intense

                # Node Mid (Violet)
                if d_node_mid < 0.0:
                    intense = max(0.0, min(1.0, -d_node_mid / 0.02))
                    core = max(0.0, min(1.0, (-d_node_mid - 0.04) / 0.02))
                    nr = 129.0 * (1.0 - core) + 240.0 * core
                    ng = 140.0 * (1.0 - core) + 250.0 * core
                    nb = 248.0 * (1.0 - core) + 255.0 * core
                    cur_r = cur_r * (1.0 - intense) + nr * intense
                    cur_g = cur_g * (1.0 - intense) + ng * intense
                    cur_b = cur_b * (1.0 - intense) + nb * intense

                # Node Bot (Emerald)
                if d_node_bot < 0.0:
                    intense = max(0.0, min(1.0, -d_node_bot / 0.02))
                    core = max(0.0, min(1.0, (-d_node_bot - 0.04) / 0.02))
                    nr = 52.0 * (1.0 - core) + 240.0 * core
                    ng = 211.0 * (1.0 - core) + 255.0 * core
                    nb = 153.0 * (1.0 - core) + 240.0 * core
                    cur_r = cur_r * (1.0 - intense) + nr * intense
                    cur_g = cur_g * (1.0 - intense) + ng * intense
                    cur_b = cur_b * (1.0 - intense) + nb * intense

                # Apex Node (Bright Diamond White with Aura)
                if d_node_apex < 0.0:
                    intense = max(0.0, min(1.0, -d_node_apex / 0.02))
                    core = max(0.0, min(1.0, (-d_node_apex - 0.03) / 0.02))
                    nr = 56.0 * (1.0 - core) + 255.0 * core
                    ng = 220.0 * (1.0 - core) + 255.0 * core
                    nb = 248.0 * (1.0 - core) + 255.0 * core
                    cur_r = cur_r * (1.0 - intense) + nr * intense
                    cur_g = cur_g * (1.0 - intense) + ng * intense
                    cur_b = cur_b * (1.0 - intense) + nb * intense

                accum_r += cur_r
                accum_g += cur_g
                accum_b += cur_b
                accum_a += cur_a

            # Average 4x MSAA samples
            idx = (py * size + px) * 4
            final_a = accum_a / 4.0
            if final_a > 0.001:
                rgba[idx] = int(min(255.0, accum_r / 4.0))
                rgba[idx + 1] = int(min(255.0, accum_g / 4.0))
                rgba[idx + 2] = int(min(255.0, accum_b / 4.0))
                rgba[idx + 3] = int(min(255.0, final_a * 255.0))

    return bytes(rgba)

def build_ico_file(sizes, output_path):
    """Builds a multi-resolution Windows ICO containing PNGs for each requested size."""
    images = []
    for s in sizes:
        print(f"  Rendering {s}x{s} icon...")
        rgba = render_omnilink_icon(s)
        png = make_png(s, s, rgba)
        images.append((s, png))

    # ICO Header: 6 bytes
    # idReserved (2), idType=1 (2), idCount (2)
    ico_bytes = bytearray(struct.pack('<HHH', 0, 1, len(images)))

    # Directory entries: 16 bytes each
    offset = 6 + len(images) * 16
    for s, png in images:
        w = 0 if s == 256 else s
        h = 0 if s == 256 else s
        ico_bytes.extend(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset))
        offset += len(png)

    # Image byte streams
    for _, png in images:
        ico_bytes.extend(png)

    with open(output_path, 'wb') as f:
        f.write(ico_bytes)

    print(f"Successfully generated Windows icon: {output_path} ({len(ico_bytes)} bytes)")

if __name__ == '__main__':
    os.makedirs('assets', exist_ok=True)
    icon_sizes = [256, 128, 64, 48, 32, 16]
    build_ico_file(icon_sizes, 'assets/icon.ico')
