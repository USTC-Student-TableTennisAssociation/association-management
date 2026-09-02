import type { UIMessageChunk } from "ai";

/**
 * Direct and single-layer answers stream immediately. Cross-layer claims and
 * side-effect receipts stay buffered until the server-side verifier resolves
 * the final text. The policy callback must derive only from runtime state.
 */
export function governFinalAnswerStream<T extends UIMessageChunk>(
  stream: ReadableStream<UIMessageChunk>,
  resolveFinalText: (rawText: string) => string,
  shouldBuffer: () => boolean,
  onDirectStream: () => void,
): ReadableStream<T> {
  let currentStepText = "";
  let lastCompletedText = "";
  let pendingFinishStep: UIMessageChunk | undefined;
  let answerEmitted = false;
  let currentStepBuffered: boolean | undefined;

  const bufferCurrentStep = () => {
    currentStepBuffered ??= shouldBuffer();
    return currentStepBuffered;
  };
  const emitAnswer = (controller: TransformStreamDefaultController<UIMessageChunk>) => {
    if (answerEmitted) return;
    answerEmitted = true;
    const text = resolveFinalText(lastCompletedText || currentStepText);
    const id = "grounded-final-answer";
    controller.enqueue({ type: "text-start", id });
    if (text) controller.enqueue({ type: "text-delta", id, delta: text });
    controller.enqueue({ type: "text-end", id });
  };

  return stream.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (pendingFinishStep && chunk.type !== "finish") {
        controller.enqueue(pendingFinishStep);
        pendingFinishStep = undefined;
      }
      switch (chunk.type) {
        case "start-step":
          currentStepText = "";
          currentStepBuffered = undefined;
          controller.enqueue(chunk);
          return;
        case "text-start":
          if (!bufferCurrentStep()) {
            onDirectStream();
            controller.enqueue(chunk);
          }
          return;
        case "text-end":
          if (!bufferCurrentStep()) controller.enqueue(chunk);
          return;
        case "text-delta":
          currentStepText += chunk.delta;
          if (!bufferCurrentStep()) {
            onDirectStream();
            controller.enqueue(chunk);
          }
          return;
        case "finish-step":
          lastCompletedText = currentStepText;
          if (bufferCurrentStep()) {
            pendingFinishStep = chunk;
          } else {
            controller.enqueue(chunk);
          }
          return;
        case "finish":
          if (pendingFinishStep) emitAnswer(controller);
          if (pendingFinishStep) controller.enqueue(pendingFinishStep);
          pendingFinishStep = undefined;
          controller.enqueue(chunk);
          return;
        default:
          controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (!answerEmitted && pendingFinishStep && (lastCompletedText || currentStepText)) {
        emitAnswer(controller);
      }
      if (pendingFinishStep) controller.enqueue(pendingFinishStep);
    },
  })) as ReadableStream<T>;
}
