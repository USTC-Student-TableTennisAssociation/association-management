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

  const namesByObjectId = new Map<string, string>();
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
  }

  for (const placeholder of placeholders) {
    const objectId = placeholder[1].trim();
    if (!namesByObjectId.has(objectId)) {
      throw new ResolvedAssertionIntegrityError(
        `${assertionLabel} 的 GlobalObject token ${objectId} 没有规范 AssertionObjectLink`,
      );
    }
  }

  return input.globalStatementTemplateMarkdown.replace(
    /\{\{object:([^{}]+)\}\}/g,
    (_, rawObjectId: string) => namesByObjectId.get(rawObjectId.trim())!,
  );
}
