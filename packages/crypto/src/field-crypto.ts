import { decrypt, encrypt, keyVersionOf } from './aead.js';
import type { MasterKey } from './master-key.js';
import type { SecretKey } from './secret-key.js';

/** Where an encrypted value lives. Ciphertext only decrypts in exactly this place. */
export interface FieldContext {
  table: string;
  column: string;
  rowId: string;
}

export interface HouseholdFieldContext extends FieldContext {
  householdId: string;
}

/** Supplies household data keys (implemented over the household_keys table in @fiscus/db). */
export interface DataKeySource {
  activeKey(householdId: string): Promise<{ version: number; key: SecretKey }>;
  keyVersion(householdId: string, version: number): Promise<SecretKey>;
}

const householdAad = (c: HouseholdFieldContext) =>
  Buffer.from(`fiscus:v1:h:${c.householdId}:${c.table}:${c.column}:${c.rowId}`, 'utf8');
const instanceAad = (c: FieldContext) =>
  Buffer.from(`fiscus:v1:i:${c.table}:${c.column}:${c.rowId}`, 'utf8');

/**
 * Field-level encryption (ADR 0005). Household data uses that household's data key; per-user
 * secrets use the instance key. Associated data binds every ciphertext to its household, table,
 * column, and row, so values can't be copied between rows or households.
 */
export class FieldCrypto {
  constructor(
    private readonly keys: DataKeySource,
    private readonly master: MasterKey,
  ) {}

  async encrypt(context: HouseholdFieldContext, plaintext: string): Promise<Buffer> {
    const { version, key } = await this.keys.activeKey(context.householdId);
    return encrypt(key, version, Buffer.from(plaintext, 'utf8'), householdAad(context));
  }

  async decrypt(context: HouseholdFieldContext, ciphertext: Buffer): Promise<string> {
    const key = await this.keys.keyVersion(context.householdId, keyVersionOf(ciphertext));
    return decrypt(key, ciphertext, householdAad(context)).toString('utf8');
  }

  encryptInstance(context: FieldContext, plaintext: string): Buffer {
    return encrypt(
      this.master.instanceKey,
      this.master.version,
      Buffer.from(plaintext, 'utf8'),
      instanceAad(context),
    );
  }

  decryptInstance(context: FieldContext, ciphertext: Buffer): string {
    return decrypt(this.master.instanceKey, ciphertext, instanceAad(context)).toString('utf8');
  }
}
