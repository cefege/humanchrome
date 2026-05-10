/**
 * Predefined embedding-model registry + recommendation helpers (IMP-0019 slice 1).
 *
 * Pure data + lookup functions — no ONNX, no transformers, no runtime cost.
 * Importers that only need PREDEFINED_MODELS / ModelPreset / getModelInfo
 * etc. (e.g. the popup UI) get a tree-shakeable surface here without
 * pulling the engine bundle.
 *
 * The full engine + offscreen IPC live in semantic-similarity-engine.ts;
 * this module is intentionally side-effect-free.
 */

// 2025 curated multilingual models (quantized for download size).
export const PREDEFINED_MODELS = {
  // Multilingual model - default recommendation
  'multilingual-e5-small': {
    modelIdentifier: 'Xenova/multilingual-e5-small',
    dimension: 384,
    description: 'Multilingual E5 Small - Lightweight multilingual model supporting 100+ languages',
    language: 'multilingual',
    performance: 'excellent',
    size: '116MB', // Quantized version
    latency: '20ms',
    multilingualFeatures: {
      languageSupport: '100+',
      crossLanguageRetrieval: 'good',
      chineseEnglishMixed: 'good',
    },
    modelSpecificConfig: {
      requiresTokenTypeIds: false, // E5 model doesn't require token_type_ids
    },
  },
  'multilingual-e5-base': {
    modelIdentifier: 'Xenova/multilingual-e5-base',
    dimension: 768,
    description: 'Multilingual E5 base - Medium-scale multilingual model supporting 100+ languages',
    language: 'multilingual',
    performance: 'excellent',
    size: '279MB', // Quantized version
    latency: '30ms',
    multilingualFeatures: {
      languageSupport: '100+',
      crossLanguageRetrieval: 'excellent',
      chineseEnglishMixed: 'excellent',
    },
    modelSpecificConfig: {
      requiresTokenTypeIds: false, // E5 model doesn't require token_type_ids
    },
  },
} as const;

export type ModelPreset = keyof typeof PREDEFINED_MODELS;

/** Get model information for a preset. */
export function getModelInfo(preset: ModelPreset) {
  return PREDEFINED_MODELS[preset];
}

/** List all available models with their preset key inlined. */
export function listAvailableModels() {
  return Object.entries(PREDEFINED_MODELS).map(([key, value]) => ({
    preset: key as ModelPreset,
    ...value,
  }));
}

/** Recommend model based on language (only multilingual-e5 series). */
export function recommendModelForLanguage(
  _language: 'en' | 'zh' | 'multilingual' = 'multilingual',
  scenario: 'speed' | 'balanced' | 'quality' = 'balanced',
): ModelPreset {
  if (scenario === 'quality') {
    return 'multilingual-e5-base';
  }
  return 'multilingual-e5-small';
}

/** Recommend model based on device performance and usage scenario. */
export function recommendModelForDevice(
  _language: 'en' | 'zh' | 'multilingual' = 'multilingual',
  deviceMemory: number = 4, // GB
  networkSpeed: 'slow' | 'fast' = 'fast',
  prioritizeSpeed: boolean = false,
): ModelPreset {
  if (deviceMemory < 4 || networkSpeed === 'slow' || prioritizeSpeed) {
    return 'multilingual-e5-small';
  }
  if (deviceMemory >= 8 && !prioritizeSpeed) {
    return 'multilingual-e5-base';
  }
  return 'multilingual-e5-small';
}

/** Get model size information (quantized version only). */
export function getModelSizeInfo(
  preset: ModelPreset,
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
) {
  const model = PREDEFINED_MODELS[preset];
  return {
    size: model.size,
    recommended: 'quantized',
    description: `${model.description} (Size: ${model.size})`,
  };
}

/** Compare performance and size of multiple models. */
export function compareModels(presets: ModelPreset[]) {
  return presets.map((preset) => {
    const model = PREDEFINED_MODELS[preset];
    return {
      preset,
      name: model.description.split(' - ')[0],
      language: model.language,
      performance: model.performance,
      dimension: model.dimension,
      latency: model.latency,
      features:
        (model as { multilingualFeatures?: Record<string, string> }).multilingualFeatures || {},
      maxLength: (model as { maxLength?: number }).maxLength || 512,
      size: model.size,
      recommendedFor: getRecommendationContext(preset),
    };
  });
}

/** Get recommended use cases for a preset. */
function getRecommendationContext(preset: ModelPreset): string[] {
  const contexts: string[] = [];
  const model = PREDEFINED_MODELS[preset];

  contexts.push('Multilingual document processing');

  if (model.performance === 'excellent') contexts.push('High accuracy requirements');
  if (model.latency.includes('20ms')) contexts.push('Fast response');

  const sizeInMB = parseInt(model.size.replace('MB', ''));
  if (sizeInMB < 300) {
    contexts.push('Mobile devices');
    contexts.push('Lightweight deployment');
  }

  if (preset === 'multilingual-e5-small') {
    contexts.push('Lightweight deployment');
  } else if (preset === 'multilingual-e5-base') {
    contexts.push('High accuracy requirements');
  }

  return contexts;
}

/** Get ONNX model filename (quantized version only). */
export function getOnnxFileNameForVersion(
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
): string {
  return 'model_quantized.onnx';
}

/** Get model identifier (quantized version only). */
export function getModelIdentifierWithVersion(
  preset: ModelPreset,
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
): string {
  const model = PREDEFINED_MODELS[preset];
  return model.modelIdentifier;
}

/** Get size comparison of all available models, sorted by size. */
export function getAllModelSizes() {
  const models = Object.entries(PREDEFINED_MODELS).map(([preset, config]) => ({
    preset: preset as ModelPreset,
    name: config.description.split(' - ')[0],
    language: config.language,
    size: config.size,
    performance: config.performance,
    latency: config.latency,
  }));

  return models.sort((a, b) => {
    const sizeA = parseInt(a.size.replace('MB', ''));
    const sizeB = parseInt(b.size.replace('MB', ''));
    return sizeA - sizeB;
  });
}
