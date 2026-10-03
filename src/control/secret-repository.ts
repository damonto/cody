import { z } from "zod";
import type { SqlDatabase } from "../platform/bindings.ts";
import { decryptConfig, encryptConfig } from "./crypto.ts";
import { ControlInputError } from "./errors.ts";
import { SECRET_PLACEHOLDER } from "../shared/secrets.ts";
import type { SecretVersion } from "./entities.ts";

/** Stages encrypted versions alongside entity writes; reads only explicitly selected secrets. */
export class SecretRepository {
  readonly pending: SecretVersion[] = [];
  private readonly values = new Map<string, string>();
  constructor(
    private readonly db: SqlDatabase,
    private readonly key: string,
    private readonly now: number,
  ) {}
  async read(id: string): Promise<string> {
    const cached = this.values.get(id);
    if (cached !== undefined) return cached;
    const row =
      this.pending.find((secret) => secret.id === id) ??
      (await this.db
        .prepare(
          "SELECT ciphertext FROM secret_versions WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(id)
        .first());
    if (!row) throw new Error("A configuration secret is missing or revoked");
    const value = z
      .string()
      .parse(
        await decryptConfig(
          z.object({ ciphertext: z.string() }).parse(row).ciphertext,
          this.key,
        ),
      );
    this.values.set(id, value);
    return value;
  }
  async seal(
    ownerId: string,
    field: string,
    value: string,
    previousId?: string | null,
  ): Promise<string> {
    if (value === SECRET_PLACEHOLDER) {
      if (!previousId)
        throw new ControlInputError("A new credential requires a secret value");
      return previousId;
    }
    if (value.startsWith("__cody_secret:"))
      throw new ControlInputError(
        "Secret references cannot be supplied as credentials",
      );
    if (previousId && (await this.read(previousId)) === value)
      return previousId;
    const id = crypto.randomUUID();
    this.values.set(id, value);
    this.pending.push({
      id,
      owner_id: ownerId,
      field,
      ciphertext: await encryptConfig(value, this.key),
      created_at: this.now,
      revoked_at: null,
    });
    return id;
  }
}
