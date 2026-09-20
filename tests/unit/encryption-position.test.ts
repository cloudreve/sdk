import { it, expect } from "vitest";
import { createCipheriv } from "node:crypto";
import { aesCtrPosition } from "../../src/transfers/index";

it("matches whole-stream AES-CTR for aligned and unaligned ranges", () => {
  const key = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(16).fill(3);
  const input = Uint8Array.from({ length: 129 }, (_, i) => i);

  const whole = createCipheriv("aes-256-ctr", key, iv).update(input);

  for (const offset of [0, 1, 15, 16, 31, 32, 127]) {
    const position = aesCtrPosition(iv, offset);
    const cipher = createCipheriv("aes-256-ctr", key, position.counter);

    cipher.update(new Uint8Array(position.skip));
    expect(cipher.update(input.slice(offset))).toEqual(whole.subarray(offset));
  }

  expect(iv).toEqual(new Uint8Array(16).fill(3));
});

it("handles large offsets and carry without 32-bit truncation", () => {
  const iv = new Uint8Array(16);

  iv[15] = 255;
  expect([...aesCtrPosition(iv, 16).counter.slice(-2)]).toEqual([1, 0]);
  expect(aesCtrPosition(new Uint8Array(16).fill(255), 16).counter).toEqual(new Uint8Array(16));

  const large = aesCtrPosition(new Uint8Array(16), 2 ** 40 + 3);

  expect(large.skip).toBe(3);
  expect(large.counter[11]).toBe(16);

  for (const [bytes, offset] of [
    [new Uint8Array(2), 0],
    [iv, -1],
    [iv, 1.5],
    [iv, Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    expect(() => aesCtrPosition(bytes, offset)).toThrow();
  }
});
