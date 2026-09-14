// Password generator — server-side mirror of `src/utils/passwordGenerator.ts`.
//
// KEEP THE FORMATS IN SYNC with the client copy. The two exist separately
// because the frontend and functions are separate TypeScript projects with
// separate tsconfig roots; `src/utils/searchTokens.ts` and its counterpart
// here are duplicated for the same reason. The formats must match exactly, or
// a password generated in the browser and one fetched from the API would not
// be recognisably the same product.
//
// Neither copy has a built-in word list. Words are always supplied by the
// caller, from the lists configured in Settings, so a caller cannot forget to
// pass them and silently generate from a vocabulary nobody chose. An empty
// list throws; `resolveWords` in ./wordLists is what callers use to get one.
//
// The randomness source differs too: the browser uses Web Crypto's
// getRandomValues, this uses Node's crypto.randomBytes. Both are CSPRNGs and
// both are consumed with the same rejection sampling, so the output
// distribution is identical.

import * as crypto from 'crypto';

const symbols = ['!', '@', '#', '$', '%', '&', '*', ')', '+', '='];

export type PasswordMode = 'simple' | 'secure' | 'word4';

export const PASSWORD_MODES: PasswordMode[] = ['simple', 'secure', 'word4'];

export function isPasswordMode(value: string): value is PasswordMode {
  return (PASSWORD_MODES as string[]).includes(value);
}

// Cryptographically secure random integer in [0, max) with rejection sampling
// to avoid modulo bias.
function secureRandom(max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  let value: number;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return value % max;
}

function pickRandom<T>(arr: T[]): T {
  return arr[secureRandom(arr.length)];
}

function randomDigit(): string {
  return secureRandom(10).toString();
}

function randomTwoDigits(): string {
  return (10 + secureRandom(90)).toString();
}

function randomFourDigits(): string {
  return (1000 + secureRandom(9000)).toString();
}

// Simple: Word + Word + 2 digits, e.g. TreeBridge47
function generateSimplePassword(words: string[]): string {
  return `${pickRandom(words)}${pickRandom(words)}${randomTwoDigits()}`;
}

// Secure: Word + digit + Word + symbol + Word, e.g. Movie3Cartoon)Bottle
function generateSecurePassword(words: string[]): string {
  return `${pickRandom(words)}${randomDigit()}${pickRandom(words)}${pickRandom(symbols)}${pickRandom(words)}`;
}

// Word4: Word + 4 digits, e.g. Tiger4829
function generateWord4Password(words: string[]): string {
  return `${pickRandom(words)}${randomFourDigits()}`;
}

function getGenerator(mode: PasswordMode): (words: string[]) => string {
  switch (mode) {
    case 'secure':
      return generateSecurePassword;
    case 'word4':
      return generateWord4Password;
    default:
      return generateSimplePassword;
  }
}

// Guard the one precondition the generator has. Callers check for an empty
// selection and return an error before reaching here, so this only fires on a
// genuine bug.
function assertWords(words: string[]): void {
  if (!words || words.length === 0) {
    throw new Error('generatePassword: no words configured');
  }
}

export function generatePassword(words: string[], mode: PasswordMode = 'simple'): string {
  assertWords(words);
  return getGenerator(mode)(words);
}

/** Generate `count` passwords in one pass, resolving the generator once. */
export function generateMany(
  count: number,
  words: string[],
  mode: PasswordMode = 'simple'
): string[] {
  assertWords(words);
  const generator = getGenerator(mode);
  const results: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    results[i] = generator(words);
  }
  return results;
}
