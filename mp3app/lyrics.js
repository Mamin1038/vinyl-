/**
 * lyrics.js
 * -------------------------------------------------------------
 * 두 가지 가사 모드를 지원한다.
 *   A. 일반 텍스트 가사
 *   B. LRC 타임드 가사 ([mm:ss.xx] 형식)
 * -------------------------------------------------------------
 */

const LRC_LINE_RE = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

/**
 * LRC 텍스트를 { time(초), text } 배열로 변환한다.
 * 한 줄에 여러 타임태그가 있는 경우(반복 구간)도 지원한다.
 * 유효한 타임태그가 하나도 없으면 null을 반환해 "일반 가사"로 처리하게 한다.
 */
function parseLRC(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const entries = [];
  let matched = false;

  for (const line of lines) {
    LRC_LINE_RE.lastIndex = 0;
    const tags = [];
    let m;
    while ((m = LRC_LINE_RE.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseInt(m[2], 10);
      const fracRaw = m[3] || '0';
      const frac = parseFloat('0.' + fracRaw);
      tags.push(min * 60 + sec + frac);
    }
    if (tags.length === 0) continue;
    matched = true;
    const content = line.replace(LRC_LINE_RE, '').trim();
    if (!content) continue; // 메타 태그 라인([ar:], [ti:] 등)은 건너뜀
    for (const t of tags) entries.push({ time: t, text: content });
  }

  if (!matched || entries.length === 0) return null;
  entries.sort((a, b) => a.time - b.time);
  return entries;
}

/**
 * 현재 재생 위치(초)에 해당하는 가사 줄의 인덱스를 찾는다.
 */
function findActiveLineIndex(lrcEntries, currentTime) {
  if (!lrcEntries || lrcEntries.length === 0) return -1;
  let lo = 0, hi = lrcEntries.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lrcEntries[mid].time <= currentTime) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 가사 문자열이 LRC 형식인지 휴리스틱으로 판단한다.
 */
function looksLikeLRC(text) {
  if (!text) return false;
  LRC_LINE_RE.lastIndex = 0;
  return LRC_LINE_RE.test(text);
}

window.LyricsEngine = { parseLRC, findActiveLineIndex, looksLikeLRC };
