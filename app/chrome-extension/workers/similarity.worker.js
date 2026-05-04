/* eslint-disable */
// js/similarity.worker.js
importScripts('../libs/ort.min.js'); // adjust path to match your file layout

// Worker globals
let session = null;
let modelPathInternal = null;
let ortEnvConfigured = false;
let sessionOptions = null;
let modelInputNames = null; // model input names

// Reusable TypedArray buffers to cut down on allocations
let reusableBuffers = {
  inputIds: null,
  attentionMask: null,
  tokenTypeIds: null,
};

// Performance counters
let workerStats = {
  totalInferences: 0,
  totalInferenceTime: 0,
  averageInferenceTime: 0,
  memoryAllocations: 0,
};

// CDN base for ONNX Runtime Web wasm/mjs assets. We ship the CPU-SIMD wasm
// locally (~11 MB) but fetch the JSEP/WebGPU wasm (~22 MB) from a CDN on
// demand to keep the unpacked extension small. Version must match the
// `ort.min.js` bundled under `public/libs/`.
const ORT_CDN_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

// Configure the ONNX Runtime environment once.
function configureOrtEnv(numThreads = 1, executionProviders = ['wasm']) {
  if (ortEnvConfigured) return;
  try {
    ort.env.wasm.numThreads = numThreads;
    ort.env.wasm.simd = true; // enable SIMD when available
    ort.env.wasm.proxy = false; // proxy is not needed inside a worker
    ort.env.logLevel = 'warning'; // 'verbose', 'info', 'warning', 'error', 'fatal'

    // Per-file wasmPaths: keep CPU-SIMD local, redirect JSEP (WebGPU) to CDN.
    // The local CPU loader/wasm live at /workers/ (web_accessible_resources).
    const localBase = new URL('./', self.location.href).href;
    ort.env.wasm.wasmPaths = {
      'ort-wasm-simd-threaded.mjs': localBase + 'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm': localBase + 'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.jsep.mjs': ORT_CDN_BASE + 'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm': ORT_CDN_BASE + 'ort-wasm-simd-threaded.jsep.wasm',
    };

    ortEnvConfigured = true;

    sessionOptions = {
      executionProviders: executionProviders,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
      // executionMode: 'sequential' // worker handles one task at a time
    };
  } catch (error) {
    console.error('Worker: Failed to configure ORT environment', error);
    throw error;
  }
}

async function initializeModel(modelPathOrData, numThreads, executionProviders) {
  try {
    configureOrtEnv(numThreads, executionProviders);

    if (!modelPathOrData) {
      throw new Error('Worker: Model path or data is not provided.');
    }

    // Check if input is ArrayBuffer (cached model data) or string (URL path)
    if (modelPathOrData instanceof ArrayBuffer) {
      console.log(
        `Worker: Initializing model from cached ArrayBuffer (${modelPathOrData.byteLength} bytes)`,
      );
      session = await ort.InferenceSession.create(modelPathOrData, sessionOptions);
      modelPathInternal = '[Cached ArrayBuffer]'; // For debugging purposes
    } else {
      console.log(`Worker: Initializing model from URL: ${modelPathOrData}`);
      modelPathInternal = modelPathOrData; // remember path for debugging/reload
      session = await ort.InferenceSession.create(modelPathInternal, sessionOptions);
    }

    // Capture input names so we can decide whether token_type_ids is required
    modelInputNames = session.inputNames;
    console.log(`Worker: ONNX session created successfully for model: ${modelPathInternal}`);
    console.log(`Worker: Model input names:`, modelInputNames);

    return { status: 'success', message: 'Model initialized' };
  } catch (error) {
    console.error(`Worker: Model initialization failed:`, error);
    session = null; // clear partial init
    modelInputNames = null;
    // Re-throw with a serializable message; Error objects don't postMessage cleanly.
    throw new Error(`Worker: Model initialization failed - ${error.message}`);
  }
}

function getOrCreateBuffer(name, requiredLength, type = BigInt64Array) {
  if (!reusableBuffers[name] || reusableBuffers[name].length < requiredLength) {
    reusableBuffers[name] = new type(requiredLength);
    workerStats.memoryAllocations++;
  }
  return reusableBuffers[name];
}

async function runBatchInference(batchData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};
    const batchSize = batchData.dims.input_ids[0];
    const seqLength = batchData.dims.input_ids[1];

    const inputIdsLength = batchData.input_ids.length;
    const attentionMaskLength = batchData.attention_mask.length;

    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(batchData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(batchData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      batchData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      batchData.dims.attention_mask,
    );

    // Only provide token_type_ids if the model expects it.
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (batchData.token_type_ids && batchData.dims.token_type_ids) {
        const tokenTypeIdsLength = batchData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(batchData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          batchData.dims.token_type_ids,
        );
      } else {
        // Default to all-zero token_type_ids.
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          batchData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    const outputData = new Float32Array(outputTensor.data);

    workerStats.totalInferences += batchSize; // batch counts as multiple inferences
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData,
        dims: outputTensor.dims,
        batchSize: batchSize,
        seqLength: seqLength,
      },
      transferList: [outputData.buffer],
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
        batchSize: batchSize,
      },
    };
  } catch (error) {
    console.error('Worker: Batch inference failed:', error);
    throw new Error(`Worker: Batch inference failed - ${error.message}`);
  }
}

async function runInference(inputData) {
  if (!session) {
    throw new Error("Worker: Session not initialized. Call 'initializeModel' first.");
  }

  const startTime = performance.now();

  try {
    const feeds = {};

    const inputIdsLength = inputData.input_ids.length;
    const attentionMaskLength = inputData.attention_mask.length;

    const inputIdsBuffer = getOrCreateBuffer('inputIds', inputIdsLength);
    const attentionMaskBuffer = getOrCreateBuffer('attentionMask', attentionMaskLength);

    for (let i = 0; i < inputIdsLength; i++) {
      inputIdsBuffer[i] = BigInt(inputData.input_ids[i]);
    }
    for (let i = 0; i < attentionMaskLength; i++) {
      attentionMaskBuffer[i] = BigInt(inputData.attention_mask[i]);
    }

    feeds['input_ids'] = new ort.Tensor(
      'int64',
      inputIdsBuffer.slice(0, inputIdsLength),
      inputData.dims.input_ids,
    );
    feeds['attention_mask'] = new ort.Tensor(
      'int64',
      attentionMaskBuffer.slice(0, attentionMaskLength),
      inputData.dims.attention_mask,
    );

    // Only provide token_type_ids if the model expects it.
    if (modelInputNames && modelInputNames.includes('token_type_ids')) {
      if (inputData.token_type_ids && inputData.dims.token_type_ids) {
        const tokenTypeIdsLength = inputData.token_type_ids.length;
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', tokenTypeIdsLength);

        for (let i = 0; i < tokenTypeIdsLength; i++) {
          tokenTypeIdsBuffer[i] = BigInt(inputData.token_type_ids[i]);
        }

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, tokenTypeIdsLength),
          inputData.dims.token_type_ids,
        );
      } else {
        // Default to all-zero token_type_ids.
        const tokenTypeIdsBuffer = getOrCreateBuffer('tokenTypeIds', inputIdsLength);
        tokenTypeIdsBuffer.fill(0n, 0, inputIdsLength);

        feeds['token_type_ids'] = new ort.Tensor(
          'int64',
          tokenTypeIdsBuffer.slice(0, inputIdsLength),
          inputData.dims.input_ids,
        );
      }
    } else {
      console.log('Worker: Skipping token_type_ids as model does not require it');
    }

    const results = await session.run(feeds);
    const outputTensor = results.last_hidden_state || results[Object.keys(results)[0]];

    const outputData = new Float32Array(outputTensor.data);

    workerStats.totalInferences++;
    const inferenceTime = performance.now() - startTime;
    workerStats.totalInferenceTime += inferenceTime;
    workerStats.averageInferenceTime = workerStats.totalInferenceTime / workerStats.totalInferences;

    return {
      status: 'success',
      output: {
        data: outputData, // return the Float32Array directly
        dims: outputTensor.dims,
      },
      transferList: [outputData.buffer], // mark as transferable
      stats: {
        inferenceTime,
        totalInferences: workerStats.totalInferences,
        averageInferenceTime: workerStats.averageInferenceTime,
        memoryAllocations: workerStats.memoryAllocations,
      },
    };
  } catch (error) {
    console.error('Worker: Inference failed:', error);
    throw new Error(`Worker: Inference failed - ${error.message}`);
  }
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;

  try {
    switch (type) {
      case 'init':
        // Support both modelPath (URL string) and modelData (ArrayBuffer)
        const modelInput = payload.modelData || payload.modelPath;
        await initializeModel(modelInput, payload.numThreads, payload.executionProviders);
        self.postMessage({ id, type: 'init_complete', status: 'success' });
        break;
      case 'infer':
        const result = await runInference(payload);
        self.postMessage(
          {
            id,
            type: 'infer_complete',
            status: 'success',
            payload: result.output,
            stats: result.stats,
          },
          result.transferList || [],
        );
        break;
      case 'batchInfer':
        const batchResult = await runBatchInference(payload);
        self.postMessage(
          {
            id,
            type: 'batchInfer_complete',
            status: 'success',
            payload: batchResult.output,
            stats: batchResult.stats,
          },
          batchResult.transferList || [],
        );
        break;
      case 'getStats':
        self.postMessage({
          id,
          type: 'stats_complete',
          status: 'success',
          payload: workerStats,
        });
        break;
      case 'clearBuffers':
        reusableBuffers = {
          inputIds: null,
          attentionMask: null,
          tokenTypeIds: null,
        };
        workerStats.memoryAllocations = 0;
        self.postMessage({
          id,
          type: 'clear_complete',
          status: 'success',
          payload: { message: 'Buffers cleared' },
        });
        break;
      default:
        console.warn(`Worker: Unknown message type: ${type}`);
        self.postMessage({
          id,
          type: 'error',
          status: 'error',
          payload: { message: `Unknown message type: ${type}` },
        });
    }
  } catch (error) {
    // Send the error as a plain object; Error instances don't always serialize cleanly.
    self.postMessage({
      id,
      type: `${type}_error`, // e.g. 'init_error' or 'infer_error'
      status: 'error',
      payload: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });
  }
};
