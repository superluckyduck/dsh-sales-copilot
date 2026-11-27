/**
 * The offline translation models this plugin offers. All of them run through the
 * same transformers.js `translation` pipeline in `mt-server.js`; the family
 * decides how a language is addressed and which pairs the weights can serve:
 *
 * - m2m100: one multilingual model, ISO-639-1-ish ids, any pair among its 100.
 * - nllb:   one multilingual model, FLORES-200 ids (`zho_Hans`, `eng_Latn`, …).
 * - opus:   one fixed direction per model (here en→zh), no language arguments.
 *
 * Every id below is a real `Xenova/*` transformers.js repository, checked
 * against the Hugging Face API before being listed here.
 */

export const MT_MODELS = [
  {
    id: 'Xenova/m2m100_418M',
    family: 'm2m100',
    label: 'M2M100 418M',
    detail: '多语种互译，覆盖中英日韩粤西法德俄葡',
    sizeMb: 600,
    license: 'MIT',
    // The two graphs every transformers.js seq2seq translation repo ships; named
    // here so a failed download can print the exact addresses it was fetching
    // even when no progress event arrived before the failure.
    weights: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_quantized.onnx'],
  },
  {
    id: 'Xenova/nllb-200-distilled-600M',
    family: 'nllb',
    label: 'NLLB-200 600M',
    detail: '中文、粤语质量更好，同样多语种',
    sizeMb: 640,
    license: 'CC-BY-NC 4.0（仅限非商业用途）',
    weights: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_quantized.onnx'],
  },
  {
    id: 'Xenova/opus-mt-en-zh',
    family: 'opus',
    pair: ['en', 'zh'],
    label: 'OPUS 英→中',
    detail: '只做英文到中文，体积小、速度快',
    sizeMb: 90,
    license: 'Apache-2.0',
    weights: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_quantized.onnx'],
  },
]

const M2M100_CODES = {
  zh: 'zh', en: 'en', ja: 'ja', ko: 'ko', yue: 'zh',
  es: 'es', fr: 'fr', de: 'de', ru: 'ru', pt: 'pt',
}

const NLLB_CODES = {
  zh: 'zho_Hans', en: 'eng_Latn', ja: 'jpn_Jpan', ko: 'kor_Hang', yue: 'yue_Hant',
  es: 'spa_Latn', fr: 'fra_Latn', de: 'deu_Latn', ru: 'rus_Cyrl', pt: 'por_Latn',
}

export const MT_MODEL_IDS = MT_MODELS.map((entry) => entry.id)

export function findMtModel(id) {
  return MT_MODELS.find((entry) => entry.id === id)
}

/** The id to use when the settings name a model this build does not ship. */
export function defaultMtModelId() {
  return MT_MODELS[0].id
}

/**
 * Model-specific language code, or undefined when the model cannot serve that
 * language at all (OPUS only knows its own direction).
 */
export function langCodeFor(model, language) {
  if (!model) return undefined
  if (model.family === 'opus') return model.pair.includes(language) ? language : undefined
  const table = model.family === 'nllb' ? NLLB_CODES : M2M100_CODES
  return table[language]
}

/** The language a piece of text is written in, best effort, without a detector. */
export function detectLanguage(text, hint) {
  if (typeof hint === 'string' && hint !== 'auto' && hint !== '') return hint
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[A-Za-z]/.test(text)) return 'en'
  return 'en'
}

/**
 * Why one translation request cannot run on the chosen model, or null when it
 * can. Kept here so the child process and the status surface agree.
 */
export function checkPair(model, sourceLanguage, targetLanguage) {
  if (!model) return '未知的离线模型'
  if (langCodeFor(model, targetLanguage) === undefined) {
    return `${model.label} 不支持目标语言「${targetLanguage}」`
  }
  if (model.family === 'opus' && sourceLanguage !== undefined) {
    if (langCodeFor(model, sourceLanguage) === undefined) {
      return `${model.label} 只支持 ${model.pair[0]}→${model.pair[1]}，请换用多语种模型`
    }
  }
  return null
}
