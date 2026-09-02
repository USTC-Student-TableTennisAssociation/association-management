import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Higher Memory chat runtime contract", () => {
  it("keeps Higher Memory maintenance in the post-turn runtime", () => {
    const route = source("src/app/api/chat/route.ts");

    expect(route).toContain("createHigherMemoryQueueTool");
    expect(route).not.toContain("queueHigherMemoryMaintenance: higherMemoryQueueToolset.tool");
    expect(route).toContain("higherMemoryQueueToolset.decision()");
    expect(route).toContain("...(higherMemoryInput ? { higherMemory: higherMemoryInput } : {})");
  });

  it("keeps ordinary Assertion review out of the foreground tool surface", () => {
    const route = source("src/app/api/chat/route.ts");

    expect(route).not.toContain("queueChatAssertionCapture: assertionQueueToolset.tool");
    expect(route).toContain("publishUserFactForView: assertionQueueToolset.foregroundTool");
    expect(route).toContain("automatic_post_turn_sidecar");
    expect(route).toContain("modelHandoff: \"disabled\"");
  });

  it("loads, writes, and independently maintains Actor-private memory", () => {
    const route = source("src/app/api/chat/route.ts");
    const lifecycle = source("src/memory/chat-assertion-lifecycle.ts");

    expect(route).toContain("loadActorPrivateMemory(requestActor.id)");
    expect(route).toContain("updateActorHigherMemory: actorHigherMemoryWriteToolset.tool");
    expect(route).not.toContain("queueActorHigherMemoryMaintenance: actorHigherMemoryQueueToolset.tool");
    expect(route).toContain("actorHigherMemoryWriteToolset.hasCommit()");
    expect(route).toContain("actorHigherMemory: actorHigherMemoryInput");
    expect(lifecycle).toContain("maintainActorHigherMemories");
  });
});
