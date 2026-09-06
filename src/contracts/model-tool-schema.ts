export type ModelToolSchemaIssue = {
  path: string;
  message: string;
};

export class ModelToolSchemaError extends Error {
  readonly issues: readonly ModelToolSchemaIssue[];

  constructor(owner: string, issues: readonly ModelToolSchemaIssue[]) {
    super(
      `${owner} 不是合法的 Sydaris Model Tool 输入契约：` +
        issues.map((issue) => `${issue.path} ${issue.message}`).join("；"),
    );
    this.name = "ModelToolSchemaError";
    this.issues = issues;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inspectSchemaNode(
  value: unknown,
  path: string,
  issues: ModelToolSchemaIssue[],
): void {
  if (value === true || value === false) return;
  const node = record(value);
  if (!node) {
    issues.push({ path, message: "必须是 JSON Schema Object 或 Boolean Schema" });
    return;
  }
  if (Object.keys(node).length === 0) {
    issues.push({ path, message: "不能使用无约束空 Schema；请声明明确类型" });
    return;
  }

  const properties = record(node.properties);
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      inspectSchemaNode(child, `${path}.properties.${key}`, issues);
    }
  }
  if (node.items !== undefined) inspectSchemaNode(node.items, `${path}.items`, issues);
  if (record(node.additionalProperties)) {
    inspectSchemaNode(node.additionalProperties, `${path}.additionalProperties`, issues);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (!Array.isArray(node[keyword])) continue;
    node[keyword].forEach((child, index) =>
      inspectSchemaNode(child, `${path}.${keyword}[${index}]`, issues)
    );
  }
  for (const keyword of ["$defs", "definitions"] as const) {
    const definitions = record(node[keyword]);
    if (!definitions) continue;
    for (const [key, child] of Object.entries(definitions)) {
      inspectSchemaNode(child, `${path}.${keyword}.${key}`, issues);
    }
  }
}

/**
 * Sydaris Model Tool ABI v1.
 *
 * Domain validators may use the full Zod/JSON Schema vocabulary. Schemas sent
 * to a language-model provider use a deliberately smaller wire contract:
 * every function accepts one top-level object and every exposed field has an
 * explicit schema. This is the common denominator required by the supported
 * OpenAI-compatible gateways.
 */
export function modelToolSchemaIssues(value: unknown): ModelToolSchemaIssue[] {
  const issues: ModelToolSchemaIssue[] = [];
  const root = record(value);
  if (!root) {
    return [{ path: "$", message: "必须是 JSON Schema Object" }];
  }
  if (root.type !== "object") {
    issues.push({ path: "$.type", message: "必须明确为 object" });
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (root[keyword] !== undefined) {
      issues.push({
        path: `$.${keyword}`,
        message: "不能作为顶层分支；请使用单一 Object 信封并在服务端精确校验",
      });
    }
  }
  if (!record(root.properties)) {
    issues.push({ path: "$.properties", message: "必须显式声明 properties" });
  }
  inspectSchemaNode(root, "$", issues);
  return issues;
}

export function assertModelToolInputSchema(value: unknown, owner: string): void {
  const issues = modelToolSchemaIssues(value);
  if (issues.length) throw new ModelToolSchemaError(owner, issues);
}
