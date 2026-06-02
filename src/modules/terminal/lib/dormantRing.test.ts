import { describe, expect, it } from "vitest";
import { DormantRing } from "./dormantRing";

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOTICE = "[ijt: dropped output during hibernation]";

function drainToString(ring: DormantRing): string {
  const parts: Uint8Array[] = [];
  ring.drain((b) => parts.push(b.slice()));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return dec.decode(out);
}

describe("DormantRing", () => {
  // The `dropHibernatedOutput` preference is implemented purely by the caps the
  // ring is constructed with: bounded (default) drops + notices; Infinity caps
  // (toggle off) keep everything and never notice.
  it("keeps every byte and shows no drop notice when unbounded", () => {
    const ring = new DormantRing(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    for (let i = 0; i < 1000; i++) ring.push(enc.encode(`line ${i}\n`));
    const out = drainToString(ring);

    expect(out).not.toContain(NOTICE);
    expect(out).toContain("line 0\n"); // oldest survives
    expect(out).toContain("line 999\n"); // newest survives
  });

  it("drops the oldest output and prepends a notice when the byte cap overflows", () => {
    const ring = new DormantRing(32, 1000); // tiny byte cap
    for (let i = 0; i < 50; i++) ring.push(enc.encode(`X${i}\n`));
    const out = drainToString(ring);

    expect(out).toContain(NOTICE);
    expect(out).toContain("X49\n"); // most recent kept
    expect(out).not.toContain("X0\n"); // oldest evicted
  });

  it("caps by chunk count as well as bytes", () => {
    const ring = new DormantRing(1_000_000, 3); // chunkCap = 3
    for (let i = 0; i < 10; i++) ring.push(enc.encode(`c${i};`));
    const out = drainToString(ring);

    expect(out).toContain(NOTICE);
    expect(out).toContain("c9;");
    expect(out).not.toContain("c0;");
  });

  it("replaces the buffer with a notice + tail when one chunk exceeds the cap", () => {
    const ring = new DormantRing(16, 1000);
    ring.push(enc.encode("A".repeat(32))); // single 32-byte chunk > 16-byte cap
    const out = drainToString(ring);

    expect(out).toContain(NOTICE);
    expect((out.match(/A/g) ?? []).length).toBe(16); // only the last cap bytes
  });

  it("emits nothing (not even a notice) when never overflowed", () => {
    const ring = new DormantRing(); // defaults, tiny payload
    ring.push(enc.encode("hello\r\n"));
    expect(drainToString(ring)).toBe("hello\r\n");
  });

  // setCaps backs the reactive `dropHibernatedOutput` toggle: flipping it
  // re-bounds the rings of already-open tabs without waiting for a respawn.
  it("evicts old output immediately when setCaps tightens the caps", () => {
    const ring = new DormantRing(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    for (let i = 0; i < 50; i++) ring.push(enc.encode(`X${i}\n`));
    ring.setCaps(32, 1000); // tighten — should drop the oldest now
    const out = drainToString(ring);

    expect(out).toContain(NOTICE);
    expect(out).toContain("X49\n"); // most recent kept
    expect(out).not.toContain("X0\n"); // oldest evicted
  });

  it("keeps everything pushed after setCaps loosens to unbounded", () => {
    const ring = new DormantRing(32, 1000); // bounded to start
    ring.push(enc.encode("seed\n"));
    ring.setCaps(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 1000; i++) ring.push(enc.encode(`line ${i}\n`));
    const out = drainToString(ring);

    expect(out).not.toContain(NOTICE);
    expect(out).toContain("seed\n"); // pre-loosen content survives
    expect(out).toContain("line 0\n");
    expect(out).toContain("line 999\n");
  });
});
