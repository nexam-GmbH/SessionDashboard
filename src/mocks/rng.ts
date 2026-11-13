/** Deterministic PRNG (mulberry32) so fixtures and screenshots are stable. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export class Rng {
  private next: () => number
  constructor(seed: number | string) {
    this.next = mulberry32(typeof seed === "string" ? hashString(seed) : seed)
  }
  float() {
    return this.next()
  }
  int(min: number, max: number) {
    return Math.floor(this.next() * (max - min + 1)) + min
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]
  }
  chance(p: number) {
    return this.next() < p
  }
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  sample<T>(arr: readonly T[], n: number): T[] {
    return this.shuffle(arr.slice()).slice(0, Math.min(n, arr.length))
  }
  hex(len: number) {
    let s = ""
    for (let i = 0; i < len; i++) s += Math.floor(this.next() * 16).toString(16)
    return s
  }
  uuid() {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${this.pick(["8", "9", "a", "b"])}${this.hex(3)}-${this.hex(12)}`
  }
}
