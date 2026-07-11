// Password generator using custom word lists
// Simple: TreeBridge47 (Word + Word + 2 digits)
// Secure: Movie3Cartoon)Bottle (Word + digit + Word + symbol + Word)
// Word4: Tiger4829 (Word + 4 digits)

// Default word lists
const defaultWords = [
  'Tree', 'Bridge', 'Cloud', 'River', 'Stone', 'Light', 'Storm', 'Flame',
  'Tiger', 'Eagle', 'Falcon', 'Phoenix', 'Dragon', 'Lion', 'Wolf', 'Bear',
  'Swift', 'Bright', 'Golden', 'Silver', 'Crystal', 'Sunny', 'Ocean', 'Forest',
  'Mountain', 'Thunder', 'Sunset', 'Autumn', 'Spring', 'Summer', 'Winter', 'Cosmic',
  'Movie', 'Cartoon', 'Bottle', 'Planet', 'Garden', 'Castle', 'Arrow', 'Shield',
  'Rocket', 'Meadow', 'Breeze', 'Frost', 'Comet', 'Blaze', 'Valley', 'Grove',
  'Hawk', 'Dolphin', 'Panther', 'Jaguar', 'Cobra', 'Raven', 'Owl', 'Fox',
  'Brave', 'Calm', 'Cool', 'Warm', 'Fresh', 'Strong', 'Quick', 'Smart'
];

const symbols = ['!', '@', '#', '$', '%', '&', '*', ')', '+', '='];

export type PasswordMode = 'simple' | 'secure' | 'word4';

export interface GeneratedPassword {
  id: string;
  password: string;
  mode: PasswordMode;
}

export interface GeneratorOptions {
  words?: string[];
  mode?: PasswordMode;
}

// Cryptographically secure random integer in [0, max) with rejection sampling
// to avoid modulo bias.
function secureRandom(max: number): number {
  if (max <= 0) return 0;
  const array = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  let value: number;
  do {
    crypto.getRandomValues(array);
    value = array[0];
  } while (value >= limit);
  return value % max;
}

// Pick random item from array
function pickRandom<T>(arr: T[]): T {
  return arr[secureRandom(arr.length)];
}

// Generate random single digit (0-9)
function randomDigit(): string {
  return secureRandom(10).toString();
}

// Generate random two digit number (10-99)
function randomTwoDigits(): string {
  return (10 + secureRandom(90)).toString();
}

// Generate random four digit number (1000-9999)
function randomFourDigits(): string {
  return (1000 + secureRandom(9000)).toString();
}

// Generate a Simple password: Word + Word + 2 digits
// Example: TreeBridge47
function generateSimplePassword(words: string[]): string {
  const word1 = pickRandom(words);
  const word2 = pickRandom(words);
  const digits = randomTwoDigits();

  return `${word1}${word2}${digits}`;
}

// Generate a Secure password: Word + digit + Word + symbol + Word
// Example: Movie3Cartoon)Bottle
function generateSecurePassword(words: string[]): string {
  const word1 = pickRandom(words);
  const digit = randomDigit();
  const word2 = pickRandom(words);
  const symbol = pickRandom(symbols);
  const word3 = pickRandom(words);

  return `${word1}${digit}${word2}${symbol}${word3}`;
}

// Generate a Word4 password: Word + 4 digits
// Example: Tiger4829
function generateWord4Password(words: string[]): string {
  const word = pickRandom(words);
  const digits = randomFourDigits();

  return `${word}${digits}`;
}

// Resolve the generator function for a given mode
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

// Generate a password based on mode
export function generatePassword(options: GeneratorOptions = {}): string {
  const { words = defaultWords, mode = 'simple' } = options;

  return getGenerator(mode)(words);
}

// Generate multiple password options for user to choose from
export function generatePasswordOptions(
  count: number = 3,
  options: GeneratorOptions = {}
): string[] {
  const passwords: string[] = [];
  for (let i = 0; i < count; i++) {
    passwords.push(generatePassword(options));
  }
  return passwords;
}

// Generate a batch of passwords efficiently
// Optimized for 500+ passwords by resolving options once
export function generateBatch(
  count: number,
  options: GeneratorOptions = {}
): GeneratedPassword[] {
  const { words = defaultWords, mode = 'simple' } = options;
  const generator = getGenerator(mode);
  const results: GeneratedPassword[] = new Array(count);

  for (let i = 0; i < count; i++) {
    results[i] = {
      id: crypto.randomUUID(),
      password: generator(words),
      mode,
    };
  }

  return results;
}

// Validate password strength (basic check)
export function validatePassword(password: string): {
  valid: boolean;
  message?: string;
} {
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters' };
  }
  return { valid: true };
}

// Get word list from Firestore word lists
export function buildGeneratorOptions(
  wordLists: { name: string; words: string[] }[],
  selectedList?: string,
  mode?: PasswordMode
): GeneratorOptions {
  const options: GeneratorOptions = { mode };

  if (!selectedList || wordLists.length === 0) {
    return options; // Use defaults
  }

  const list = wordLists.find((l) => l.name === selectedList);
  if (list) {
    options.words = list.words;
  }

  return options;
}
