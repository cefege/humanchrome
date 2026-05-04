// Stub for @xenova/transformers to avoid loading sharp at test time.
// The real module is only used inside the offscreen document at runtime.
export const env = {
  allowLocalModels: true,
  useBrowserCache: true,
  remoteHost: '',
  remotePathTemplate: '',
  backends: { onnx: { wasm: { wasmPaths: '' } } },
};

export const AutoTokenizer = {
  from_pretrained: async () => ({
    encode: () => ({ input_ids: [], attention_mask: [] }),
    decode: () => '',
  }),
};

export class Tensor {
  data: unknown;
  dims: number[];
  constructor(data: unknown, dims: number[] = []) {
    this.data = data;
    this.dims = dims;
  }
}

export type PreTrainedTokenizer = unknown;
