/**
 * Decoder for base64-encoded boolean bitsets used by the Cloudreve backend.
 *
 * The backend serialises permission/capability flags as a `[]byte` encoded
 * with standard base64.  Each bit position maps to a specific flag
 * (e.g. `NavigatorCapability.create_file` = bit 0).
 *
 * Ported from cloudreve-frontend-pro `src/util/boolset.ts`.
 */
/** @public */
export class Boolset {
  private readonly data: Uint8Array;

  constructor(base64?: string) {
    if (!base64) {
      this.data = new Uint8Array(0);

      return;
    }

    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);

      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }

      this.data = bytes;
    } catch {
      this.data = new Uint8Array(0);
    }
  }

  /** Returns `true` when the bit at `index` is set. */
  enabled(index: number): boolean {
    const byteIndex = Math.floor(index / 8);

    if (byteIndex >= this.data.length) {
      return false;
    }

    return (this.data[byteIndex]! & (1 << (index % 8))) !== 0;
  }
}
