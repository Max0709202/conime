// 依存なしの最小 PNG エンコーダ（RGB・8bit）。MockProvider のサンプル画像用
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class Canvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 3);
  }

  set(x: number, y: number, [r, g, b]: RGB, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = Math.round(this.pixels[i] * (1 - alpha) + r * alpha);
    this.pixels[i + 1] = Math.round(this.pixels[i + 1] * (1 - alpha) + g * alpha);
    this.pixels[i + 2] = Math.round(this.pixels[i + 2] * (1 - alpha) + b * alpha);
  }

  fill(shader: (x: number, y: number) => RGB | null) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = shader(x, y);
        if (c) this.set(x, y, c);
      }
    }
  }

  async toPng(): Promise<Uint8Array> {
    const raw = new Uint8Array((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 3 + 1)] = 0; // filter: none
      raw.set(this.pixels.subarray(y * this.width * 3, (y + 1) * this.width * 3), y * (this.width * 3 + 1) + 1);
    }
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.width);
    v.setUint32(4, this.height);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8bit, RGB
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", await deflate(raw)),
      chunk("IEND", new Uint8Array()),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [128, 128, 160];
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
