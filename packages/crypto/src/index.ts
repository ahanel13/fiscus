// SPDX-License-Identifier: AGPL-3.0-or-later
export { DecryptionError, decrypt, encrypt, keyVersionOf } from './aead.js';
export {
  FieldCrypto,
  type DataKeySource,
  type FieldContext,
  type HouseholdFieldContext,
} from './field-crypto.js';
export {
  encryptionKeyEnv,
  encryptionKeyVersionEnv,
  generateDataKey,
  MasterKey,
  previousEncryptionKeyEnv,
  previousEncryptionKeyVersionEnv,
} from './master-key.js';
export {
  envKeyProvider,
  type EnvKeys,
  KeyConfigError,
  type KeyProvider,
  MasterKeyNotLoadedError,
  MasterKeys,
  masterKeysOrExit,
} from './master-keys.js';
export { SecretKey } from './secret-key.js';
