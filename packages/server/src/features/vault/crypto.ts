/**
 * Vault cryptography.
 *
 * Every primitive here comes from Node's built-in `crypto`, which is OpenSSL —
 * no JavaScript implementations of ciphers, and no new dependencies. The one
 * thing this file does invent is the *arrangement* of those primitives, which
 * is where password vaults actually go wrong, so it is documented in full.
 *
 * ## The shape
 *
 *   master password ──Argon2id(salt)──► passwordKey ──┐
 *                                                     ├─► unwraps vaultKey
 *   recovery code ────HKDF-SHA256─────► recoveryKey ──┘
 *
 *   vaultKey ──AES-256-GCM──► every item
 *
 * The items are encrypted with a random `vaultKey`, and that key is *wrapped*
 * separately by each way of unlocking it. This is the same envelope design
 * 1Password and Bitwarden use, and it has one property that matters enormously:
 * changing the master password, or adding a recovery method, re-wraps a single
 * 32-byte key rather than re-encrypting the whole vault.
 */
import {
  argon2,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

/**
 * Argon2id cost. Well above the OWASP floor of 19 MiB / t=2, because a vault is
 * unlocked rarely and the cost is paid by an attacker on every guess. Measured
 * at ~680ms on this machine; memory is what defeats GPU and ASIC cracking, so
 * it is preferred over passes.
 */
export const KDF = {
  memoryKiB: 256 * 1024,
  passes: 3,
  parallelism: 1,
  keyLength: 32,
  saltLength: 16,
} as const;

/** Bumped if these parameters ever change, so old vaults can still be opened. */
export const KDF_VERSION = 1;

const GCM_NONCE_BYTES = 12;
const VAULT_KEY_BYTES = 32;
const RECOVERY_BYTES = 32;

/* ------------------------------------------------------------------ */
/* Key derivation                                                      */
/* ------------------------------------------------------------------ */

/**
 * Master password to key. Deliberately slow — this is the only step standing
 * between a stolen database file and every password in it.
 */
export function deriveKeyFromPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: KDF.memoryKiB,
        passes: KDF.passes,
        parallelism: KDF.parallelism,
        tagLength: KDF.keyLength,
      },
      (error, result) => {
        if (error) reject(error);
        // Copied into its own buffer: Node allocates small Buffers from a
        // shared pool, so holding the raw result can keep unrelated memory alive.
        else resolve(Buffer.from(result));
      }
    );
  });
}

/**
 * Recovery code to key.
 *
 * HKDF rather than Argon2 because a recovery code is 256 random bits, not a
 * human-chosen password — there is no dictionary to slow down, and nothing to
 * gain from making legitimate recovery take a second.
 */
export function deriveKeyFromRecoveryCode(code: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', code, Buffer.alloc(0), 'everything-vault-recovery-v1', KDF.keyLength));
}

/* ------------------------------------------------------------------ */
/* Sealing                                                             */
/* ------------------------------------------------------------------ */

export interface Sealed {
  /** Base64: nonce ‖ ciphertext ‖ tag. One field, so it cannot be half-stored. */
  blob: string;
}

/**
 * AES-256-GCM with a fresh random nonce every time.
 *
 * A 96-bit random nonce is safe here by a wide margin: the birthday bound bites
 * around 2^32 encryptions under one key, and this vault holds hundreds of items
 * re-encrypted by hand. GCM is also authenticated, so tampering is detected
 * rather than silently decrypting to rubbish.
 */
export function seal(key: Buffer, plaintext: Buffer | string): Sealed {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext as never)), cipher.final()]);
  return { blob: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64') };
}

/** Throws if the key is wrong or the data was altered — the two are indistinguishable, by design. */
export function open(key: Buffer, sealed: Sealed | string): Buffer {
  const raw = Buffer.from(typeof sealed === 'string' ? sealed : sealed.blob, 'base64');
  if (raw.length < GCM_NONCE_BYTES + 16) throw new Error('sealed data is too short to be valid');

  const nonce = raw.subarray(0, GCM_NONCE_BYTES);
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(GCM_NONCE_BYTES, raw.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ------------------------------------------------------------------ */
/* The vault key and its wrappings                                     */
/* ------------------------------------------------------------------ */

export const newVaultKey = (): Buffer => randomBytes(VAULT_KEY_BYTES);
export const newSalt = (): Buffer => randomBytes(KDF.saltLength);
export const newRecoveryCode = (): Buffer => randomBytes(RECOVERY_BYTES);

export const wrapVaultKey = (vaultKey: Buffer, wrappingKey: Buffer): string => seal(wrappingKey, vaultKey).blob;

export function unwrapVaultKey(blob: string, wrappingKey: Buffer): Buffer {
  const key = open(wrappingKey, blob);
  if (key.length !== VAULT_KEY_BYTES) throw new Error('unwrapped key is the wrong size');
  return key;
}

/* ------------------------------------------------------------------ */
/* Split recovery                                                      */
/* ------------------------------------------------------------------ */

export interface RecoveryShares {
  a: Buffer;
  b: Buffer;
}

/**
 * Split a secret into two shares, both of which are needed.
 *
 * A one-time pad: share A is random, share B is the secret XORed with it.
 * Either share alone is *information-theoretically* meaningless — not merely
 * hard to break, but carrying literally no information about the secret. So
 * storing one in Google and one elsewhere means a compromise of either place,
 * on its own, reveals nothing.
 *
 * The flip side is that both are required. Lose one and the vault is only
 * openable with the master password.
 */
export function splitSecret(secret: Buffer): RecoveryShares {
  const a = randomBytes(secret.length);
  const b = Buffer.alloc(secret.length);
  for (let i = 0; i < secret.length; i++) b[i] = secret[i] ^ a[i];
  return { a, b };
}

export function combineShares(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) throw new Error('recovery shares are different lengths — one of them is wrong');
  const secret = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) secret[i] = a[i] ^ b[i];
  return secret;
}

/* ------------------------------------------------------------------ */
/* Human-transcribable encoding                                        */
/* ------------------------------------------------------------------ */

/**
 * Crockford base32: no I, L, O or U, so there is no 1/I or 0/O ambiguity when
 * a share is written on paper and typed back in months later.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function encodeShare(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)?.join('-') ?? out;
}

export function decodeShare(text: string): Buffer {
  const cleaned = text
    .toUpperCase()
    .replace(/[-\s]/g, '')
    // Fold the characters Crockford treats as equivalent, so a transcription
    // slip is forgiven rather than silently producing the wrong key.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`"${char}" is not part of a recovery share`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Constant-time compare, for anything that could be probed by guessing. */
export function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
