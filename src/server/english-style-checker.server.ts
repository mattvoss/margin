import type { EnglishStyleCheck, EnglishStyleCheckResult } from '../lib/writingEvaluation'

export interface EnglishStyleRules {
  maxSentenceWords: number
  maxParagraphWords: number
  repeatedWordWindow: number
  repeatedWordThreshold: number
  warnPassiveVoice: boolean
  warnAdverbs: boolean
  warnMixedQuotes: boolean
  ignoreWords: string[]
}

export const defaultEnglishStyleRules: EnglishStyleRules = {
  maxSentenceWords: 45,
  maxParagraphWords: 180,
  repeatedWordWindow: 250,
  repeatedWordThreshold: 4,
  warnPassiveVoice: false,
  warnAdverbs: false,
  warnMixedQuotes: true,
  ignoreWords: [],
}

const MAX_CHARS = 100_000
const MAX_SENTENCES = 2_000
const MAX_EVIDENCE = 12
const STOP_WORDS = new Set('a an and are as at be been but by for from had has have he her him his i i in is it its me my nor not of on or our she so that the their them they this to was we were will with you your'.split(' '))

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []
}

function sentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((item) => item.trim()).filter(Boolean).slice(0, MAX_SENTENCES) ?? []
}

function check(id: EnglishStyleCheck['id'], label: string, status: EnglishStyleCheck['status'], detail: string, extra: Partial<EnglishStyleCheck> = {}): EnglishStyleCheck {
  return { id, label, status, detail, ...extra }
}

export function checkEnglishStyle(input: {
  draft: string
  rules?: Partial<EnglishStyleRules>
}): EnglishStyleCheckResult {
  const rules = { ...defaultEnglishStyleRules, ...input.rules }
  const draft = input.draft.slice(0, MAX_CHARS).trim()
  if (!draft) {
    return { version: 1, language: 'en', disclaimer: 'These are configurable English-language editing signals, not objective judgments of literary quality or authorship.', checks: [check('sentence_length', 'Sentence length', 'not_applicable', 'No prose was supplied.')], warnings: 0 }
  }
  const sentenceList = sentences(draft)
  const sentenceWords = sentenceList.map(words)
  const checks: EnglishStyleCheck[] = []
  const long = sentenceList.map((sentence, index) => ({ sentence, count: sentenceWords[index]!.length })).filter((item) => item.count > rules.maxSentenceWords).slice(0, MAX_EVIDENCE)
  checks.push(check('sentence_length', 'Sentence length', long.length ? 'warning' : 'pass', long.length ? `${long.length} sentence(s) exceed ${rules.maxSentenceWords} words.` : `No sentence exceeds ${rules.maxSentenceWords} words.`, { count: long.length, threshold: rules.maxSentenceWords, evidence: long.map((item) => `${item.count} words: ${item.sentence.slice(0, 500)}`) }))

  const lengths = sentenceWords.map((item) => item.length).filter((length) => length > 0)
  const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0
  const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0
  checks.push(check('sentence_length_variance', 'Sentence-length variance', 'pass', lengths.length > 1 ? `Average sentence length is ${average.toFixed(1)} words with variance ${variance.toFixed(1)}; variation is reported for review, not treated as a quality score.` : 'Not enough sentences to calculate variation.', { count: lengths.length }))

  const paragraphs = draft.split(/\n\s*\n/gu).map((paragraph) => ({ paragraph, count: words(paragraph).length })).filter((item) => item.count > rules.maxParagraphWords).slice(0, MAX_EVIDENCE)
  checks.push(check('paragraph_length', 'Paragraph length', paragraphs.length ? 'warning' : 'pass', paragraphs.length ? `${paragraphs.length} paragraph(s) exceed ${rules.maxParagraphWords} words.` : `No paragraph exceeds ${rules.maxParagraphWords} words.`, { count: paragraphs.length, threshold: rules.maxParagraphWords, evidence: paragraphs.map((item) => `${item.count} words: ${item.paragraph.slice(0, 500)}`) }))

  const ignored = new Set([...STOP_WORDS, ...rules.ignoreWords.map((word) => word.toLowerCase())])
  const allWords = words(draft)
  const frequencies = new Map<string, number>()
  for (let index = 0; index < allWords.length; index += rules.repeatedWordWindow) {
    const windowFrequencies = new Map<string, number>()
    for (const word of allWords.slice(index, index + rules.repeatedWordWindow)) {
      if (word.length < 4 || ignored.has(word)) continue
      windowFrequencies.set(word, (windowFrequencies.get(word) ?? 0) + 1)
    }
    for (const [word, count] of windowFrequencies) {
      frequencies.set(word, Math.max(frequencies.get(word) ?? 0, count))
    }
  }
  const repeated = [...frequencies.entries()].filter(([, count]) => count >= rules.repeatedWordThreshold).sort((a, b) => b[1] - a[1]).slice(0, MAX_EVIDENCE)
  checks.push(check('word_repetition', 'Repeated words', repeated.length ? 'warning' : 'pass', repeated.length ? `${repeated.length} content word(s) repeat within a local window.` : 'No repeated content words exceeded the configured threshold.', { count: repeated.length, threshold: rules.repeatedWordThreshold, evidence: repeated.map(([word, count]) => `${word}: ${count} occurrences`) }))

  const starterCounts = new Map<string, number>()
  for (const item of sentenceWords) {
    if (item.length >= 3) starterCounts.set(item.slice(0, 3).join(' '), (starterCounts.get(item.slice(0, 3).join(' ')) ?? 0) + 1)
  }
  const starters = [...starterCounts.entries()].filter(([, count]) => count >= 3).slice(0, MAX_EVIDENCE)
  checks.push(check('sentence_starter_repetition', 'Repeated sentence starters', starters.length ? 'warning' : 'pass', starters.length ? `${starters.length} sentence starter(s) repeat three or more times.` : 'No repeated sentence starters were detected.', { count: starters.length, evidence: starters.map(([starter, count]) => `${starter}: ${count} sentences`) }))

  const straight = /"[^"\n]+"/u.test(draft)
  const curly = /“[^”\n]+”/u.test(draft)
  checks.push(check('quote_style', 'Dialogue quote style', straight && curly && rules.warnMixedQuotes ? 'warning' : 'pass', straight && curly && rules.warnMixedQuotes ? 'Both straight and curly dialogue quotes appear.' : 'Dialogue quote style is consistent or no mixed style was found.', { count: Number(straight) + Number(curly) }))

  const dialogueWords = (draft.match(/“[^”\n]+”|"[^"\n]+"/gu) ?? []).flatMap(words).length
  const dialogueRatio = allWords.length ? dialogueWords / allWords.length : 0
  checks.push(check('dialogue_ratio', 'Dialogue ratio', 'pass', `${Math.round(dialogueRatio * 100)}% of detected words are inside dialogue quotes; no default target is enforced.`, { count: dialogueWords }))

  const dialogueTags = draft.match(/\b(?:said|asked|replied|shouted|whispered|murmured|exclaimed)\b/giu) ?? []
  checks.push(check('dialogue_tag_usage', 'Dialogue tags', 'pass', `${dialogueTags.length} common dialogue tag(s) detected; neutral tags are not treated as errors.`, { count: dialogueTags.length }))

  const adverbs = allWords.filter((word) => word.endsWith('ly') && word.length > 4)
  checks.push(check('adverb_usage', 'Adverb usage', rules.warnAdverbs && adverbs.length > 0 ? 'warning' : 'pass', `${adverbs.length} possible -ly adverb(s) detected; this is informational unless configured as a warning.`, { count: adverbs.length }))

  const passive = sentenceList.filter((sentence) => /\b(?:was|were|is|are|been|being)\s+[a-z]+(?:ed|en)\b/iu.test(sentence)).slice(0, MAX_EVIDENCE)
  checks.push(check('passive_voice_signal', 'Possible passive voice', rules.warnPassiveVoice && passive.length ? 'warning' : 'pass', passive.length ? `${passive.length} possible passive construction(s) detected.` : 'No possible passive constructions were detected.', { count: passive.length, evidence: passive }))

  const fragments = sentenceList.filter((sentence) => words(sentence).length <= 3 && !/\b(?:is|are|was|were|be|have|has|do|does|did|can|could|will|would|should)\b/iu.test(sentence)).slice(0, MAX_EVIDENCE)
  checks.push(check('fragment_density', 'Possible fragments', 'pass', `${fragments.length} short segment(s) may be fragments; intentional rhythm is valid and no default warning is applied.`, { count: fragments.length, evidence: fragments }))

  const warnings = checks.filter((item) => item.status === 'warning').length
  return { version: 1, language: 'en', disclaimer: 'These are configurable English-language editing signals, not objective judgments of literary quality or authorship.', checks, warnings }
}
