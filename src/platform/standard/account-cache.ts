import { decryptConfig } from "../../control/crypto.ts";
import { storedSchema, type Stored } from "../../providers/oauth/state.ts";

/** Bounded immutable decode cache. Every call still obtains current ciphertext
 * from coordinated storage; this can never supply an account during an outage.
 */
export class AccountDecodeCache {
  private readonly entries = new Map<
    string,
    { value: Promise<Stored>; expires: number }
  >();
  private size = 0;
  constructor(private readonly key: string) {}

  async load(ciphertext: string): Promise<Stored> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) {
        this.entries.delete(key);
        this.size -= key.length;
      }
    }
    let entry = this.entries.get(ciphertext);
    if (!entry) {
      const value = decryptConfig(ciphertext, this.key).then((raw) =>
        storedSchema.parse(raw),
      );
      entry = { value, expires: now + 60_000 };
      if (ciphertext.length <= 256 * 1024) {
        while (
          this.entries.size >= 64 ||
          this.size + ciphertext.length > 1024 * 1024
        ) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.entries.delete(oldest);
          this.size -= oldest.length;
        }
        this.entries.set(ciphertext, entry);
        this.size += ciphertext.length;
        void value.catch(() => {
          if (this.entries.get(ciphertext)?.value === value) {
            this.entries.delete(ciphertext);
            this.size -= ciphertext.length;
          }
        });
      }
    }
    return structuredClone(await entry.value);
  }

  clear(): void {
    this.entries.clear();
    this.size = 0;
  }
}
