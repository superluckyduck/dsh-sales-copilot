# Model notices

These notices cover the speech-recognition models the plugin uses. The weights
are **not** distributed with this repository or the npm package: the DeepSeek
Harness SenseVoice provider downloads them once on first use, and a local
`models/` directory (ignored by git) can be used to seed the same cache.

## SenseVoice (ASR)

- `sensevoice-onnx/model.int8.onnx` and `sensevoice-onnx/tokens.txt` are the
  SenseVoiceSmall model exported to ONNX by the
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project, from
  [csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17).
- Model weights: **FunASR Model License v1.1**, © Alibaba Group / FunAudioLLM.
  Redistribution is permitted with attribution. See
  <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>.
- The sherpa-onnx export tooling is Apache-2.0
  (<https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE>).

## Silero VAD

- `silero/silero_vad.onnx` is the Silero VAD model exported to ONNX, from
  [csukuangfj/vad](https://huggingface.co/csukuangfj/vad).
- License: MIT (Silero models), © Silero.
