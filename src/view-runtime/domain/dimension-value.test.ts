import { describe, expect, it } from "vitest";

import type { DimensionDefinition } from "@/contracts";
import {
  DimensionValueValidationError,
  validateCardDimensionValues,
  validateDimensionValue,
} from "@/view-runtime/domain/dimension-value";

function definition(
  type: DimensionDefinition["type"],
  extra: Partial<DimensionDefinition> = {},
): DimensionDefinition {
  return { key: type, label: type, type, ...extra };
}

describe("Typed Dimension values", () => {
  it.each([
    [definition("text"), "场地", "场地"],
    [definition("rich_text"), "**已确认**", "**已确认**"],
    [definition("integer"), 12, 12],
    [definition("decimal"), "12.3400", "12.34"],
    [definition("boolean"), true, true],
    [definition("enum", { constraints: { enumOptions: [{ key: "OPEN", label: "开放" }] } }), "OPEN", "OPEN"],
    [definition("date"), "2026-08-19", "2026-08-19"],
    [definition("datetime"), "2026-08-19T10:30:00+08:00", "2026-08-19T10:30:00+08:00"],
    [definition("date_range"), { start: "2026-08-19", end: "2026-08-20" }, { start: "2026-08-19", end: "2026-08-20" }],
    [definition("datetime_range"), { start: "2026-08-19T10:00:00+08:00" }, { start: "2026-08-19T10:00:00+08:00" }],
    [definition("money", { constraints: { allowedCurrencies: ["CNY"] } }), { amount: "100.500", currency: "CNY" }, { amount: "100.5", currency: "CNY" }],
  ] as const)("round-trips and normalizes %s", (schema, value, expected) => {
    expect(validateDimensionValue(schema, value)).toEqual(expected);
  });

  it.each([
    [definition("integer"), 1.2],
    [definition("decimal"), 1.2],
    [definition("decimal"), "01.2"],
    [definition("boolean"), "true"],
    [definition("enum", { constraints: { enumOptions: [{ key: "OPEN", label: "开放" }] } }), "开放"],
    [definition("date"), "2026-02-30"],
    [definition("datetime"), "2026-08-19T10:30:00"],
    [definition("date_range"), { start: "2026-08-20", end: "2026-08-19" }],
    [definition("datetime_range"), { start: "2026-08-20T10:00:00Z", end: "2026-08-19T10:00:00Z" }],
    [definition("money"), { amount: "1", currency: "rmb" }],
    [definition("money", { constraints: { allowedCurrencies: ["CNY"] } }), { amount: "1", currency: "USD" }],
  ] as const)("rejects invalid %s value", (schema, value) => {
    expect(() => validateDimensionValue(schema, value)).toThrow(DimensionValueValidationError);
  });

  it("rejects undeclared keys and applies validated defaults", () => {
    const definitions: DimensionDefinition[] = [
      definition("text", { key: "name", required: true }),
      definition("integer", { key: "count", defaultValue: 0, constraints: { min: 0 } }),
    ];
    expect(validateCardDimensionValues(definitions, { name: "测试" })).toEqual({
      name: "测试",
      count: 0,
    });
    expect(() => validateCardDimensionValues(definitions, { name: "测试", arbitrary: true }))
      .toThrow("未声明的 Dimension");
    expect(() => validateCardDimensionValues(definitions, {})).toThrow("是必填项");
  });
});
