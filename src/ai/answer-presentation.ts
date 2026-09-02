/**
 * Presentation policy is deliberately independent from evidence collection.
 * The model receives business facts and references; protocol diagnostics stay
 * in the server-side Evidence Contract used by Answer Verifier.
 */
export const ANSWER_PRESENTATION_INSTRUCTIONS = `
最终回答应像自然对话，不要像工具执行报告或 Evidence 调试面板。

- 先直接回答用户真正问的内容；是非题通常先用一句“有/没有/是/不是”回答，再补最少的必要说明。
- 根据问题复杂度决定结构。只有多项比较、步骤或较复杂结果才使用标题和清单；不要固定套用“读取结果、匹配情况、覆盖度、结论、边界说明”。
- 除非用户明确询问系统诊断，否则不要展示 found、matchedCardCount、coverage、scope、complete、stateVersion、schemaVersion 等内部协议字段。
- 证据引用紧跟它支持的自然语言结论。不要为了展示引用而重复同一事实。
- 只有省略边界会让结论产生误导时，才用一句简短自然语言说明边界；不要复述 Evidence Contract。
- 不要在每个回答末尾机械追加“需要吗”“如果你需要我可以继续”。只有确实缺少一个用户决定时才提问。
`.trim();
