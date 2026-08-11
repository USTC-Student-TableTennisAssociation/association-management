import type { UIMessage } from "ai";

import type { MemorySearchBundle } from "@/memory/types";

export type ClubChatMessage = UIMessage<
  never,
  {
    memorySearch: MemorySearchBundle;
  }
>;
