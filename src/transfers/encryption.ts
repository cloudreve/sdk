import { ApiError } from "../protocol/index.ts";

/** Full 128-bit AES-CTR counter position; adapters consume `skip` keystream bytes before the range. @public */
export function aesCtrPosition(
  iv: Uint8Array,
  byteOffset: number,
): { counter: Uint8Array; skip: number } {
  if (
    !(iv instanceof Uint8Array) ||
    iv.length !== 16 ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0
  ) {
    throw new ApiError(-1, "Invalid AES-CTR position");
  }

  let counterValue = 0n;

  for (const byte of iv) {
    counterValue = (counterValue << 8n) | BigInt(byte);
  }

  counterValue = (counterValue + BigInt(Math.floor(byteOffset / 16))) & ((1n << 128n) - 1n);

  const counter = new Uint8Array(16);

  for (let index = 15; index >= 0; index--) {
    counter[index] = Number(counterValue & 255n);
    counterValue >>= 8n;
  }

  return { counter, skip: byteOffset % 16 };
}
