/**
 * Minimal WAV helpers for the 16 kHz mono 16-bit PCM that the capture helper
 * and the speech service agree on.
 */

export const TARGET_SAMPLE_RATE = 16000

/**
 * Read the canonical 44-byte PCM header written by `native/capture.ps1`.
 * @param {Buffer} buffer
 * @returns {{sampleRate:number, channels:number, bits:number, dataOffset:number, dataBytes:number}|null}
 */
export function readCanonicalHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  const format = buffer.readUInt16LE(20)
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bits = buffer.readUInt16LE(34)
  const dataOffset = 44
  if (format !== 1 || bits !== 16) return null
  const declared = buffer.readUInt32LE(40)
  const available = buffer.length - dataOffset
  const dataBytes = Math.min(declared === 0 ? available : declared, available)
  return { sampleRate, channels, bits, dataOffset, dataBytes }
}

/** Root-mean-square amplitude of 16-bit PCM data, normalised to 0..1. */
export function rms(buffer, header) {
  const start = header ? header.dataOffset : 0
  const bytes = header ? header.dataBytes : buffer.length - start
  const samples = Math.floor(bytes / 2)
  if (samples <= 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const value = buffer.readInt16LE(start + i * 2) / 32768
    sum += value * value
  }
  return Math.sqrt(sum / samples)
}

/** Peak absolute amplitude of 16-bit PCM data, normalised to 0..1. */
export function peak(buffer, header) {
  const start = header ? header.dataOffset : 0
  const bytes = header ? header.dataBytes : buffer.length - start
  const samples = Math.floor(bytes / 2)
  let max = 0
  for (let i = 0; i < samples; i += 1) {
    const value = Math.abs(buffer.readInt16LE(start + i * 2))
    if (value > max) max = value
  }
  return max / 32768
}

/**
 * Lift quiet room audio toward a usable level without clipping, so the
 * recogniser sees speech recorded through a partially turned-down mixer.
 * Returns the input buffer when no change is useful.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function normalizeGain(buffer, { targetPeak = 0.7, minPeak = 0.02, maxGain = 12 } = {}) {
  const header = readCanonicalHeader(buffer)
  if (header === null || header.dataBytes < 320) return buffer
  const currentPeak = peak(buffer, header)
  if (currentPeak < minPeak || currentPeak >= targetPeak) return buffer
  let gain = targetPeak / currentPeak
  if (gain > maxGain) gain = maxGain
  if (gain < 1.2) return buffer
  const output = Buffer.from(buffer)
  const samples = Math.floor(header.dataBytes / 2)
  for (let i = 0; i < samples; i += 1) {
    const offset = header.dataOffset + i * 2
    let value = Math.round(buffer.readInt16LE(offset) * gain)
    if (value > 32767) value = 32767
    else if (value < -32768) value = -32768
    output.writeInt16LE(value, offset)
  }
  return output
}
