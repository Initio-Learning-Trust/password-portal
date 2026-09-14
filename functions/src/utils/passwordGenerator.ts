// Password generator — server-side mirror of `src/utils/passwordGenerator.ts`.
//
// KEEP THE FORMATS IN SYNC with the client copy. The two exist separately
// because the frontend and functions are separate TypeScript projects with
// separate tsconfig roots; `src/utils/searchTokens.ts` and its counterpart
// here are duplicated for the same reason. The formats must match exactly, or
// a password generated in the browser and one fetched from the API would not
// be recognisably the same product.
//
// The call signatures deliberately differ. The client takes the words as a
// required argument and has no default list, so a caller cannot forget to pass
// the configured words and silently generate from somewhere else. This copy
// keeps a `defaultWords` fallback because the public API must still return a
// password when no list is configured.
//
// The randomness source differs too: the browser uses Web Crypto's
// getRandomValues, this uses Node's crypto.randomBytes. Both are CSPRNGs and
// both are consumed with the same rejection sampling, so the output
// distribution is identical.

import * as crypto from 'crypto';

// Default word list, used when no Firestore list is configured or selected.
export const defaultWords = [
  'Tree', 'Bridge', 'Cloud', 'River', 'Stone', 'Light', 'Storm', 'Flame',
  'Tiger', 'Eagle', 'Falcon', 'Phoenix', 'Dragon', 'Lion', 'Wolf', 'Bear',
  'Swift', 'Bright', 'Golden', 'Silver', 'Crystal', 'Sunny', 'Ocean', 'Forest',
  'Mountain', 'Thunder', 'Sunset', 'Autumn', 'Spring', 'Summer', 'Winter', 'Cosmic',
  'Movie', 'Cartoon', 'Bottle', 'Planet', 'Garden', 'Castle', 'Arrow', 'Shield',
  'Rocket', 'Meadow', 'Breeze', 'Frost', 'Comet', 'Blaze', 'Valley', 'Grove',
  'Hawk', 'Dolphin', 'Panther', 'Jaguar', 'Cobra', 'Raven', 'Owl', 'Fox',
  'Brave', 'Calm', 'Cool', 'Warm', 'Fresh', 'Strong', 'Quick', 'Smart',
];

const symbols = ['!', '@', '#', '$', '%', '&', '*', ')', '+', '='];

export type PasswordMode = 'simple' | 'secure' | 'word4';

export const PASSWORD_MODES: PasswordMode[] = ['simple', 'secure', 'word4'];

export function isPasswordMode(value: string): value is PasswordMode {
  return (PASSWORD_MODES as string[]).includes(value);
}

export interface GeneratorOptions {
  words?: string[];
  mode?: PasswordMode;
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

export function generatePassword(options: GeneratorOptions = {}): string {
  const { words = defaultWords, mode = 'simple' } = options;
  return getGenerator(mode)(words.length > 0 ? words : defaultWords);
}

/** Generate `count` passwords in one pass, resolving the generator once. */
export function generateMany(count: number, options: GeneratorOptions = {}): string[] {
  const { words = defaultWords, mode = 'simple' } = options;
  const source = words.length > 0 ? words : defaultWords;
  const generator = getGenerator(mode);
  const results: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    results[i] = generator(source);
  }
  return results;
}
