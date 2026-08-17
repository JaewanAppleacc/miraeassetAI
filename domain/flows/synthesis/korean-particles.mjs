// Generic Korean particle (조사) selection -- attaches the correct
// batchim-sensitive particle to ANY word, never a per-question/per-word
// lookup table. Uses Unicode codepoint arithmetic on the Hangul syllable
// block (AC00-D7A3) to determine whether the word's last syllable ends in
// a consonant (받침 있음) or not, then picks the matching particle form.
// Falls back to the no-batchim form for non-Hangul-final words (numbers,
// Latin letters, punctuation) since that is the more common real-world
// case in this domain (values ending in units like "원"/"%"/digits) and
// never throws on unexpected input.
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONGSEONG_COUNT = 28; // no batchim = index 0

function hasBatchim(word) {
  if (typeof word !== "string" || word.length === 0) return false;
  const trimmed = word.trim();
  // Display labels often end in punctuation or a parenthesized unit.
  // Select from the last Hangul syllable that actually carries Korean
  // pronunciation: "금액(원)" follows 원, while "비율(%)" falls back to
  // 율 because the parenthesis contains no Hangul syllable.
  const hangulMatches = trimmed.match(/[가-힣]/g);
  const lastChar = hangulMatches?.at(-1) ?? trimmed.slice(-1);
  const code = lastChar.codePointAt(0);
  if (code === undefined || code < HANGUL_BASE || code > HANGUL_LAST) return false;
  const jongseongIndex = (code - HANGUL_BASE) % JONGSEONG_COUNT;
  return jongseongIndex !== 0;
}

// particles: { batchim: "...", noBatchim: "..." } -- e.g. { batchim: "은", noBatchim: "는" }
function attach(word, particles) {
  return hasBatchim(word) ? particles.batchim : particles.noBatchim;
}

export function topicParticle(word) { return attach(word, { batchim: "은", noBatchim: "는" }); }
export function subjectParticle(word) { return attach(word, { batchim: "이", noBatchim: "가" }); }
export function objectParticle(word) { return attach(word, { batchim: "을", noBatchim: "를" }); }
export function conjunctionParticle(word) { return attach(word, { batchim: "과", noBatchim: "와" }); }
// 방향/도달 조사 ("으로"/"로") -- the specific bug reported against the
// old fixed-string "로" template ("매출액로의" instead of "매출액으로의").
export function directionParticle(word) { return attach(word, { batchim: "으로", noBatchim: "로" }); }

export function withTopic(word) { return `${word}${topicParticle(word)}`; }
export function withSubject(word) { return `${word}${subjectParticle(word)}`; }
export function withObject(word) { return `${word}${objectParticle(word)}`; }
export function withConjunction(word) { return `${word}${conjunctionParticle(word)}`; }
export function withDirection(word) { return `${word}${directionParticle(word)}`; }
