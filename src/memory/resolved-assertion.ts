export type ResolvedAssertionReference = {
  globalObjectId: string;
  canonicalName: string;
};

export class ResolvedAssertionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolvedAssertionIntegrityError";
  }
}

export function renderResolvedAssertion(input: {
  globalStatementTemplateMarkdown: string;
  references: ResolvedAssertionReference[];
  assertionKey?: string;
}): string {
  const assertionLabel = input.assertionKey ? `Assertion ${input.assertionKey}` : "Assertion";
  if (input.globalStatementTemplateMarkdown.includes("{{fragment:")) {
    throw new ResolvedAssertionIntegrityError(
      `${assertionLabel} 的 Global template 仍包含 source-local Fragment`,
    );
  }
  const placeholders = [
    ...input.globalStatementTemplateMarkdown.matchAll(/\{\{object:([^{}]+)\}\}/g),
  ];

  if (placeholders.length !== input.references.length) {
    throw new ResolvedAssertionIntegrityError(
      `${assertionLabel} 的 Global Object token 数 ${placeholders.length} ` +
        `与 reference atom 数 ${input.references.length} 不一致`,
    );
  }

  const namesByObjectId = new Map<string, string>();
  const expectedCounts = new Map<string, number>();
  for (const reference of input.references) {
    if (!reference.globalObjectId || !reference.canonicalName.trim()) {
      throw new ResolvedAssertionIntegrityError(
        `${assertionLabel} 存在无效的 GlobalObject reference`,
      );
    }
    const existingName = namesByObjectId.get(reference.globalObjectId);
    if (existingName && existingName !== reference.canonicalName) {
      throw new ResolvedAssertionIntegrityError(
        `${assertionLabel} 的 GlobalObject ${reference.globalObjectId} 出现不一致 canonical name`,
      );
    }
    namesByObjectId.set(reference.globalObjectId, reference.canonicalName);
    expectedCounts.set(
      reference.globalObjectId,
      (expectedCounts.get(reference.globalObjectId) ?? 0) + 1,
    );
  }

  const actualCounts = new Map<string, number>();
  for (const placeholder of placeholders) {
    const objectId = placeholder[1].trim();
    actualCounts.set(objectId, (actualCounts.get(objectId) ?? 0) + 1);
  }
  const allObjectIds = new Set([...expectedCounts.keys(), ...actualCounts.keys()]);
  for (const objectId of allObjectIds) {
    if (expectedCounts.get(objectId) !== actualCounts.get(objectId)) {
      throw new ResolvedAssertionIntegrityError(
        `${assertionLabel} 的 GlobalObject ${objectId} token/reference atom 数量不一致`,
      );
    }
  }

  return input.globalStatementTemplateMarkdown.replace(
    /\{\{object:([^{}]+)\}\}/g,
    (_, rawObjectId: string) => namesByObjectId.get(rawObjectId.trim())!,
  );
}
