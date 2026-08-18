import { z } from "zod";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** A serializable schema plus the runtime parser used at Echo's trust boundaries. */
export interface ContractSchema<T = unknown> {
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
}

export function zodContractSchema<T>(schema: z.ZodType<T>): ContractSchema<T> {
  return {
    jsonSchema: z.toJSONSchema(schema) as JsonSchema,
    parse: (value) => schema.parse(value),
  };
}
