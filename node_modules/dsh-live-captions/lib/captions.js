/**
 * Caption sentence rules.
 *
 * Audio is captured in takes, not in sentences: the helper cuts at a pause when
 * it hears one, and otherwise at the quietest stretch it can find before the cap.
 * A take that ended only because the cap ran out is often the first half of a
 * sentence, so its follow-up take is merged back into the same caption instead of
 * becoming a new line. These helpers decide when that happens and how the halves
 * are joined.
 */

/** Trailing punctuation that a forced cut invents; it must not survive a join. */
const SOFT_TAIL = /[\s。，、；：,;:.．]+$/u
/** A finished sentence: merging past this would glue two sentences together. */
const STRONG_TAIL = /[？！?!…]$/u
/** Text that ends in a Latin letter or digit needs a space before more of it. */
const LATIN_TAIL = /[A-Za-z0-9]$/
const LATIN_HEAD = /^[A-Za-z0-9]/
/**
 * A caption that never closes must not become one endless line. One continuation
 * is enough to finish the word a cut landed in; past that the sentence starts
 * again in a new caption.
 */
const MAX_MERGES = 1
/** Belt and braces: a very long line stops absorbing continuations. */
const MAX_MERGE_LENGTH = 80

/**
 * Join two caption halves. Chinese/Japanese/Korean text is concatenated as is;
 * two Latin halves get the space the cut swallowed ("real" + "time" must not
 * become "realtime"). The terminator that a forced cut appended is dropped, so a
 * sentence split by the cap reads as one sentence again.
 */
export function mergeCaptionText(previous, addition) {
  const left = String(previous ?? '').replace(SOFT_TAIL, '')
  const right = String(addition ?? '').trimStart()
  if (left === '') return right
  if (right === '') return left
  if (LATIN_TAIL.test(left) && LATIN_HEAD.test(right)) return `${left} ${right}`
  return left + right
}

/** A caption that is still waiting for the rest of its utterance. */
export function shouldMergeCaption(previous, text) {
  if (previous === null || previous === undefined) return false
  if (previous.awaitingMore !== true) return false
  if (typeof text !== 'string' || text.trim() === '') return false
  if ((previous.merges ?? 0) >= MAX_MERGES) return false
  const line = String(previous.text ?? '')
  // A line that already ends like a sentence keeps its own caption.
  if (STRONG_TAIL.test(line.trimEnd())) return false
  if (line.length >= MAX_MERGE_LENGTH) return false
  return true
}
