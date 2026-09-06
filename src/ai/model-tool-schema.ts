import {
  asSchema,
  jsonSchema,
  type JSONSchema7,
  type Schema,
  type ToolSet,
} from "ai";

import { assertModelToolInputSchema } from "@/contracts/model-tool-schema";

type RuntimeParser<Value> = (value: unknown) => Value;

type RuntimeContract<Value> = {
  jsonSchema: Readonly<Record<string, unknown>>;
  parse: RuntimeParser<Value>;
};

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Bind a portable model-facing wire schema to an authoritative runtime parser. */
export function createModelToolSchema<Value>(input: {
  name: string;
  jsonSchema: JSONSchema7 | Readonly<Record<string, unknown>>;
  parse: RuntimeParser<Value>;
}): Schema<Value> {
  assertModelToolInputSchema(input.jsonSchema, input.name);
  return jsonSchema<Value>(input.jsonSchema as JSONSchema7, {
    validate(value) {
      try {
        return { success: true, value: input.parse(value) };
      } catch (error) {
        return { success: false, error: errorValue(error) };
      }
    },
  });
}

/** Adapt a provider-neutral plugin/domain contract at the model boundary. */
export function createContractModelToolSchema<Value>(
  name: string,
  contract: RuntimeContract<Value>,
): Schema<Value> {
  return createModelToolSchema({
    name,
    jsonSchema: contract.jsonSchema,
    parse: (value) => contract.parse(value),
  });
}

/** Validate the exact ToolSet assembled for a model call before network I/O. */
export async function assertModelToolSet(toolSet: ToolSet): Promise<void> {
  for (const [name, definition] of Object.entries(toolSet)) {
    if (!("inputSchema" in definition) || definition.inputSchema === undefined) continue;
    const schema = asSchema(definition.inputSchema);
    assertModelToolInputSchema(await schema.jsonSchema, `Tool ${name}`);
  }
}
