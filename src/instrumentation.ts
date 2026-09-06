/** Recover durable background work whenever a Node.js Sydaris process starts. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureMemoryAssertionIndexInBackground } = await import(
    "@/memory/assertion-index-job"
  );
  ensureMemoryAssertionIndexInBackground();
}
