function configuredConcurrency(name: string, fallback: number): number {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : fallback;
}

export const DEEP_FILE_CONCURRENCY = 1;
export const GLOBAL_OBJECT_CONCURRENCY = 1;

export function deepSourceCompilationConcurrency(): number {
  return configuredConcurrency("COLD_START_MAX_PARALLEL_COMPILATIONS", 18);
}

export function coarseCompilationConcurrency(): number {
  return configuredConcurrency("LIBRARY_COARSE_CONCURRENCY", 18);
}

export function catalogCompilationConcurrency(): number {
  return configuredConcurrency("LIBRARY_CATALOG_CONCURRENCY", 18);
}

export function textModelConcurrency(): number {
  return configuredConcurrency("AI_TEXT_MAX_IN_FLIGHT", 18);
}

export function visionModelConcurrency(): number {
  return configuredConcurrency("AI_VISION_MAX_IN_FLIGHT", 18);
}

export function coldStartModelConcurrency(): number {
  return configuredConcurrency("COLD_START_MODEL_MAX_IN_FLIGHT", 18);
}
