// terrain-noise.ts
// Summary: Provides TypeScript Perlin noise utilities for creating gentle hill elevation grids used by the
//          terrain editor and default terrain setup.
// Structure: PerlinNoise class -> generateGentleHills(width,height,scale,amplitude) export.
// Usage: import { generateGentleHills } from '../utils/terrain-noise.js' to produce a 2D array of elevation values.
// ---------------------------------------------------------------------------

// Classic Perlin noise implementation adapted from Stefan Gustavson's public domain code.
class PerlinNoise {
  private readonly permutation: number[];
  private readonly p: Uint8Array;

  constructor() {
    this.permutation = [
      151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
      8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,
      219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,
      68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,
      133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,
      80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,
      109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,
      85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,
      152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,
      108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,
      144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,
      106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,
      67,29,24,72,243,141,128,195,78,66,215,61,156,180
    ];
    this.p = new Uint8Array(512);
    for (let i = 0; i < 512; i += 1) this.p[i] = this.permutation[i & 255];
  }
  private fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
  private lerp(t: number, a: number, b: number): number { return a + t * (b - a); }
  private grad(hash: number, x: number, y: number, z: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }
  noise(x: number, y: number, z = 0): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    let fx = x - Math.floor(x);
    let fy = y - Math.floor(y);
    let fz = z - Math.floor(z);
    const u = this.fade(fx);
    const v = this.fade(fy);
    const w = this.fade(fz);
    const A = this.p[X] + Y;
    const AA = this.p[A] + Z;
    const AB = this.p[A + 1] + Z;
    const B = this.p[X + 1] + Y;
    const BA = this.p[B] + Z;
    const BB = this.p[B + 1] + Z;
    return this.lerp(w,
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA], fx, fy, fz), this.grad(this.p[BA], fx - 1, fy, fz)),
        this.lerp(u, this.grad(this.p[AB], fx, fy - 1, fz), this.grad(this.p[BB], fx - 1, fy - 1, fz))
      ),
      this.lerp(v,
        this.lerp(u, this.grad(this.p[AA + 1], fx, fy, fz - 1), this.grad(this.p[BA + 1], fx - 1, fy, fz - 1)),
        this.lerp(u, this.grad(this.p[AB + 1], fx, fy - 1, fz - 1), this.grad(this.p[BB + 1], fx - 1, fy - 1, fz - 1))
      )
    );
  }
}

// Create a width x height grid of gentle hills using Perlin noise.
export function generateGentleHills(width: number, height: number, scale = 0.1, amplitude = 20): number[][] {
  const noise = new PerlinNoise();
  const grid: number[][] = [];
  for (let y = 0; y < height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < width; x += 1) {
      const value = noise.noise(x * scale, y * scale, 0);
      row.push(Number((((value + 1) / 2) * amplitude).toFixed(2)));
    }
    grid.push(row);
  }
  return grid;
}

export { PerlinNoise };
