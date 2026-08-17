import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export function normalizeLoginName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function validatePassword(value: string): void {
  if (value.length < 8 || value.length > 200) {
    throw new Error("密码长度必须在 8 到 200 个字符之间。");
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return [
    "scrypt",
    "v=1",
    `N=${SCRYPT_COST}`,
    `r=${SCRYPT_BLOCK_SIZE}`,
    `p=${SCRYPT_PARALLELIZATION}`,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== "v=1" ||
    parts[2] !== `N=${SCRYPT_COST}` ||
    parts[3] !== `r=${SCRYPT_BLOCK_SIZE}` ||
    parts[4] !== `p=${SCRYPT_PARALLELIZATION}`
  ) return false;

  try {
    const salt = Buffer.from(parts[5], "base64url");
    const expected = Buffer.from(parts[6], "base64url");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await deriveKey(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
