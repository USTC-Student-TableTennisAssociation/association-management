import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Higher Memory chat runtime contract", () => {
  it("exposes and consumes the proactive Higher Memory maintenance queue", () => {
    const route = source("src/app/api/chat/route.ts");

    expect(route).toContain("createHigherMemoryQueueTool");
    expect(route).toContain("queueHigherMemoryMaintenance: higherMemoryQueueToolset.tool");
    expect(route).toContain('"queueHigherMemoryMaintenance"');
    expect(route).toContain("higherMemoryQueueToolset.decision()");
    expect(route).toContain("...(higherMemoryInput ? { higherMemory: higherMemoryInput } : {})");
  });

  it("loads, writes, and independently maintains Actor-private memory", () => {
    const route = source("src/app/api/chat/route.ts");
    const lifecycle = source("src/memory/chat-assertion-lifecycle.ts");

    expect(route).toContain("loadActorPrivateMemory(requestActor.id)");
    expect(route).toContain("updateActorHigherMemory: actorHigherMemoryWriteToolset.tool");
    expect(route).toContain("queueActorHigherMemoryMaintenance: actorHigherMemoryQueueToolset.tool");
    expect(route).toContain("actorHigherMemoryWriteToolset.hasCommit()");
    expect(route).toContain("actorHigherMemory: actorHigherMemoryInput");
    expect(lifecycle).toContain("maintainActorHigherMemories");
  });
});
