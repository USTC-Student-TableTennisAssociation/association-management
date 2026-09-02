import { definePlugin } from "@sydaris/plugin-sdk";

import { libraryTriageSkill } from "@/library/skill";

export const libraryBuiltinPlugin = definePlugin({
  id: "sydaris.library",
  version: "1.0.0",
  contributes: {
    skills: [libraryTriageSkill],
  },
});
