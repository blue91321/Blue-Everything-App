/**
 * Proves the vault cryptography before anything is built on top of it.
 *
 * These are the checks whose failure would be silent and catastrophic: a vault
 * that "works" while encrypting with a predictable key, or accepting the wrong
 * password, looks identical from the outside to one that doesn't.
 *
 *   npm run vault-check -w @everything/server
 */
import {
  KDF,
  combineShares,
  decodeShare,
  deriveKeyFromPassword,
  deriveKeyFromRecoveryCode,
  encodeShare,
  newRecoveryCode,
  newSalt,
  newVaultKey,
  open,
  seal,
  splitSecret,
  unwrapVaultKey,
  wrapVaultKey,
} from '../features/vault/crypto.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

console.log('\nkey derivation');
const salt = newSalt();
const started = Date.now();
const key = await deriveKeyFromPassword('correct horse battery staple', salt);
const elapsed = Date.now() - started;
check('derives a 32-byte key', key.length === 32);
check('costs real time (Argon2id, 256 MiB)', elapsed > 200, `${elapsed}ms`);
check(
  'same password and salt give the same key',
  (await deriveKeyFromPassword('correct horse battery staple', salt)).equals(key)
);
check(
  'a different salt gives a different key',
  !(await deriveKeyFromPassword('correct horse battery staple', newSalt())).equals(key)
);
check('a different password gives a different key', !(await deriveKeyFromPassword('wrong', salt)).equals(key));

console.log('\nsealing');
const vaultKey = newVaultKey();
const secret = JSON.stringify({ username: 'blake', password: 'hunter2' });
const sealed = seal(vaultKey, secret);
check('round trips', open(vaultKey, sealed).toString() === secret);
check('the plaintext does not appear in the ciphertext', !Buffer.from(sealed.blob, 'base64').toString('latin1').includes('hunter2'));
check(
  'encrypting twice gives different ciphertext',
  seal(vaultKey, secret).blob !== seal(vaultKey, secret).blob,
  'fresh nonce each time'
);

let wrongKeyRejected = false;
try {
  open(newVaultKey(), sealed);
} catch {
  wrongKeyRejected = true;
}
check('the wrong key is rejected', wrongKeyRejected);

// Flip one bit in the ciphertext body; GCM must refuse it rather than return junk.
const tampered = Buffer.from(sealed.blob, 'base64');
tampered[20] ^= 1;
let tamperRejected = false;
try {
  open(vaultKey, tampered.toString('base64'));
} catch {
  tamperRejected = true;
}
check('tampering is detected', tamperRejected);

console.log('\nkey wrapping');
const wrapped = wrapVaultKey(vaultKey, key);
check('unwraps back to the same vault key', unwrapVaultKey(wrapped, key).equals(vaultKey));

let badPasswordRejected = false;
try {
  unwrapVaultKey(wrapped, await deriveKeyFromPassword('wrong password', salt));
} catch {
  badPasswordRejected = true;
}
check('the wrong master password cannot unwrap it', badPasswordRejected);

// The whole point of the envelope: a second, independent way in.
const recoveryCode = newRecoveryCode();
const recoveryWrapped = wrapVaultKey(vaultKey, deriveKeyFromRecoveryCode(recoveryCode));
check(
  'the recovery code opens the same vault key',
  unwrapVaultKey(recoveryWrapped, deriveKeyFromRecoveryCode(recoveryCode)).equals(vaultKey)
);
check(
  'changing the master password would not touch the items',
  unwrapVaultKey(wrapVaultKey(vaultKey, await deriveKeyFromPassword('a new password', salt)), await deriveKeyFromPassword('a new password', salt)).equals(vaultKey)
);

console.log('\nsplit recovery');
const { a, b } = splitSecret(recoveryCode);
check('both shares together rebuild the code', combineShares(a, b).equals(recoveryCode));
check('share A alone is not the code', !a.equals(recoveryCode));
check('share B alone is not the code', !b.equals(recoveryCode));
check(
  'neither share leaks any byte of the code',
  !a.some((byte, i) => byte === recoveryCode[i] && byte === b[i]),
  'one-time pad'
);

// Shares get written down and typed back in, so the encoding has to survive that.
const encoded = encodeShare(a);
check('encodes without ambiguous characters', !/[ILOU]/.test(encoded.replace(/-/g, '')), encoded.slice(0, 17) + '…');
check('decodes back exactly', decodeShare(encoded).equals(a));
check('survives lower case and stray spaces', decodeShare(encoded.toLowerCase().replace(/-/g, ' ')).equals(a));
check(
  'a wrong share rebuilds the wrong code rather than half-working',
  !combineShares(a, splitSecret(recoveryCode).b).equals(recoveryCode)
);

console.log('\nend to end');
{
  // Exactly what happens on setup, then on a recovery months later.
  const setupSalt = newSalt();
  const setupVaultKey = newVaultKey();
  const item = seal(setupVaultKey, JSON.stringify({ password: 's3cret' }));
  const byPassword = wrapVaultKey(setupVaultKey, await deriveKeyFromPassword('master pw', setupSalt));
  const code = newRecoveryCode();
  const byRecovery = wrapVaultKey(setupVaultKey, deriveKeyFromRecoveryCode(code));
  const shares = splitSecret(code);
  const printedA = encodeShare(shares.a);
  const printedB = encodeShare(shares.b);

  const viaPassword = unwrapVaultKey(byPassword, await deriveKeyFromPassword('master pw', setupSalt));
  check('unlocks with the master password', JSON.parse(open(viaPassword, item).toString()).password === 's3cret');

  const rebuilt = combineShares(decodeShare(printedA), decodeShare(printedB));
  const viaRecovery = unwrapVaultKey(byRecovery, deriveKeyFromRecoveryCode(rebuilt));
  check(
    'and with the two written-down shares, master password forgotten',
    JSON.parse(open(viaRecovery, item).toString()).password === 's3cret'
  );
}

console.log(
  failures === 0
    ? `\n\x1b[32mVault crypto sound.\x1b[0m  Argon2id m=${KDF.memoryKiB / 1024}MiB t=${KDF.passes} p=${KDF.parallelism}, AES-256-GCM\n`
    : `\n\x1b[31m${failures} failed — do not build on this.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
