/**
 * Keccak-256 (the Ethereum hash, original 0x01 padding, not NIST SHA3-256).
 *
 * Node's `crypto` has no keccak-256, and the Project_Generator needs it for one job only: checking that
 * the calldata of a shrunk handler call starts with the selector of the handler function it names, so
 * that a stale sequence is never decoded with the wrong signature. A small BigInt implementation avoids
 * a dependency for that; it is tested against known vectors.
 */

const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, n: bigint): bigint => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & MASK);

/** Keccak-f[1600] on 25 lanes, lane (x, y) at index x + 5 * y. */
function keccakF(lanes: bigint[]): void {
  let R = 1;
  for (let round = 0; round < 24; round++) {
    // theta
    const C: bigint[] = [];
    for (let x = 0; x < 5; x++) {
      C[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5]! ^ rotl(C[(x + 1) % 5]!, 1n);
      for (let y = 0; y < 5; y++) lanes[x + 5 * y] = lanes[x + 5 * y]! ^ d;
    }
    // rho and pi
    let x = 1;
    let y = 0;
    let current = lanes[x + 5 * y]!;
    for (let t = 0; t < 24; t++) {
      const nx = y;
      const ny = (2 * x + 3 * y) % 5;
      x = nx;
      y = ny;
      const tmp = lanes[x + 5 * y]!;
      lanes[x + 5 * y] = rotl(current, BigInt(((t + 1) * (t + 2)) / 2) % 64n);
      current = tmp;
    }
    // chi
    for (let yy = 0; yy < 5; yy++) {
      const T: bigint[] = [];
      for (let xx = 0; xx < 5; xx++) T[xx] = lanes[xx + 5 * yy]!;
      for (let xx = 0; xx < 5; xx++) {
        lanes[xx + 5 * yy] = T[xx]! ^ (~T[(xx + 1) % 5]! & MASK & T[(xx + 2) % 5]!);
      }
    }
    // iota
    for (let j = 0; j < 7; j++) {
      R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
      if (R & 2) lanes[0] = lanes[0]! ^ (1n << BigInt((1 << j) - 1));
    }
  }
}

/** Keccak-256 of `data`, as 32 bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] = (padded[data.length] ?? 0) ^ 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) ^ 0x80;
  const lanes: bigint[] = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + b]!);
      lanes[i] = lanes[i]! ^ lane;
    }
    keccakF(lanes);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = lanes[i]!;
    for (let b = 0; b < 8; b++) {
      out[8 * i + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** `0x`-prefixed keccak-256 of a UTF-8 string. */
export function keccak256Utf8(text: string): string {
  return "0x" + hex(keccak256(new TextEncoder().encode(text)));
}

/** 4-byte selector of a canonical signature such as `transfer(address,uint256)`, as `0x` + 8 hex digits. */
export function selectorOf(signature: string): string {
  return keccak256Utf8(signature).slice(0, 10);
}
