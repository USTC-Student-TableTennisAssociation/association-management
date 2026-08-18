import type { DimensionDefinition } from "@/contracts/view";

export class DimensionValueValidationError extends Error {
  constructor(
    readonly dimensionKey: string,
    message: string,
  ) {
    super(`Dimension ${dimensionKey}: ${message}`);
    this.name = "DimensionValueValidationError";
  }
}

type DateRange = { start: string; end?: string };
type Money = { amount: string; currency: string };

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTimeWithOffsetPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(definition: DimensionDefinition, message: string): never {
  throw new DimensionValueValidationError(definition.key, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  definition: DimensionDefinition,
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length || missing.length) {
    fail(
      definition,
      `字段不正确${missing.length ? `，缺少 ${missing.join(", ")}` : ""}` +
        `${extra.length ? `，多余 ${extra.join(", ")}` : ""}`,
    );
  }
}

export function normalizeDecimal(value: string): string {
  if (!decimalPattern.test(value)) {
    throw new Error("必须是不含指数的十进制字符串");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const normalized = normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function decimalParts(value: string): { negative: boolean; digits: bigint; scale: number } {
  const normalized = normalizeDecimal(value);
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ""] = unsigned.split(".");
  return {
    negative,
    digits: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimals(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const aValue = a.digits * (BigInt(10) ** BigInt(scale - a.scale)) * (a.negative ? BigInt(-1) : BigInt(1));
  const bValue = b.digits * (BigInt(10) ** BigInt(scale - b.scale)) * (b.negative ? BigInt(-1) : BigInt(1));
  return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
}

function validateStringConstraints(
  definition: DimensionDefinition,
  value: string,
): string {
  const constraints = definition.constraints;
  if (constraints?.minLength !== undefined && value.length < constraints.minLength) {
    fail(definition, `长度不能少于 ${constraints.minLength}`);
  }
  if (constraints?.maxLength !== undefined && value.length > constraints.maxLength) {
    fail(definition, `长度不能超过 ${constraints.maxLength}`);
  }
  if (constraints?.pattern !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(constraints.pattern);
    } catch {
      fail(definition, "Schema pattern 不是合法正则表达式");
    }
    if (!pattern.test(value)) fail(definition, "不符合 pattern 约束");
  }
  return value;
}

function validateDate(definition: DimensionDefinition, value: unknown): string {
  if (typeof value !== "string") fail(definition, "必须是 YYYY-MM-DD 字符串");
  const match = datePattern.exec(value);
  if (!match) fail(definition, "必须是 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(definition, "不是有效日期");
  }
  return value;
}

function validateDateTime(definition: DimensionDefinition, value: unknown): string {
  if (typeof value !== "string" || !dateTimeWithOffsetPattern.test(value)) {
    fail(definition, "必须是带 Z 或 UTC offset 的 ISO 8601 datetime");
  }
  if (Number.isNaN(Date.parse(value))) fail(definition, "不是有效 datetime");
  return value;
}

function validateRange(
  definition: DimensionDefinition,
  value: unknown,
  validateBoundary: (definition: DimensionDefinition, value: unknown) => string,
): DateRange {
  if (!isPlainObject(value)) fail(definition, "必须是 {start,end?}");
  requireExactKeys(definition, value, ["start"], ["end"]);
  const start = validateBoundary(definition, value.start);
  const end = value.end === undefined ? undefined : validateBoundary(definition, value.end);
  if (end !== undefined) {
    const startValue = definition.type === "date_range" ? start : Date.parse(start);
    const endValue = definition.type === "date_range" ? end : Date.parse(end);
    if (startValue > endValue) fail(definition, "end 不能早于 start");
  }
  return end === undefined ? { start } : { start, end };
}

function validateNumberConstraints(
  definition: DimensionDefinition,
  value: number,
): number {
  const { min, max } = definition.constraints ?? {};
  if (min !== undefined && value < Number(min)) fail(definition, `不能小于 ${min}`);
  if (max !== undefined && value > Number(max)) fail(definition, `不能大于 ${max}`);
  return value;
}

function validateDecimalConstraints(
  definition: DimensionDefinition,
  value: string,
): string {
  const { min, max } = definition.constraints ?? {};
  if (min !== undefined && compareDecimals(value, String(min)) < 0) {
    fail(definition, `不能小于 ${min}`);
  }
  if (max !== undefined && compareDecimals(value, String(max)) > 0) {
    fail(definition, `不能大于 ${max}`);
  }
  return value;
}

export function validateDimensionValue(
  definition: DimensionDefinition,
  value: unknown,
): unknown {
  switch (definition.type) {
    case "text":
    case "rich_text":
      if (typeof value !== "string") fail(definition, "必须是字符串");
      return validateStringConstraints(definition, value);
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        fail(definition, "必须是安全整数");
      }
      return validateNumberConstraints(definition, value);
    case "decimal": {
      if (typeof value !== "string") fail(definition, "必须是十进制字符串");
      let normalized: string;
      try {
        normalized = normalizeDecimal(value);
      } catch (error) {
        fail(definition, error instanceof Error ? error.message : String(error));
      }
      return validateDecimalConstraints(definition, normalized);
    }
    case "boolean":
      if (typeof value !== "boolean") fail(definition, "必须是 boolean");
      return value;
    case "enum": {
      if (typeof value !== "string") fail(definition, "必须是 enum option key");
      const options = definition.constraints?.enumOptions ?? [];
      if (!options.some((option) => option.key === value)) {
        fail(definition, `不是允许的 enum option：${value}`);
      }
      return value;
    }
    case "date":
      return validateDate(definition, value);
    case "datetime":
      return validateDateTime(definition, value);
    case "date_range":
      return validateRange(definition, value, validateDate);
    case "datetime_range":
      return validateRange(definition, value, validateDateTime);
    case "money": {
      if (!isPlainObject(value)) fail(definition, "必须是 {amount,currency}");
      requireExactKeys(definition, value, ["amount", "currency"]);
      if (typeof value.amount !== "string") fail(definition, "amount 必须是十进制字符串");
      if (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) {
        fail(definition, "currency 必须是大写 ISO 4217 代码");
      }
      const allowed = definition.constraints?.allowedCurrencies;
      if (allowed && !allowed.includes(value.currency)) {
        fail(definition, `不允许币种 ${value.currency}`);
      }
      let amount: string;
      try {
        amount = normalizeDecimal(value.amount);
      } catch (error) {
        fail(definition, `amount ${error instanceof Error ? error.message : String(error)}`);
      }
      validateDecimalConstraints(definition, amount);
      return { amount, currency: value.currency } satisfies Money;
    }
  }
}

export function validateCardDimensionValues(
  definitions: readonly DimensionDefinition[],
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const unknown = Object.keys(values).filter((key) => !byKey.has(key));
  if (unknown.length) throw new Error(`未声明的 Dimension：${unknown.join(", ")}`);

  const result: Record<string, unknown> = {};
  for (const definition of definitions) {
    const value = values[definition.key];
    if (value === undefined) {
      if (definition.defaultValue !== undefined) {
        result[definition.key] = validateDimensionValue(definition, definition.defaultValue);
      } else if (definition.required) {
        fail(definition, "是必填项");
      }
      continue;
    }
    result[definition.key] = validateDimensionValue(definition, value);
  }
  return result;
}
