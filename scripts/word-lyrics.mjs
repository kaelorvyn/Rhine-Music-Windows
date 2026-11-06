// Platform timestamps only: never invent timings for text without word boundaries.
export function validWords(text, words, time) {
  return Array.isArray(words) && words.length > 0 && words.length <= 2000 &&
    words.every(w => w && typeof w.text === 'string') && words.map(w => w.text).join('').trim() === text.trim() &&
    words.every((w, i) => typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end) &&
      w.start >= time - .001 && w.end > w.start && w.end <= 86400 && (!i || w.start >= words[i - 1].end - .001));
}

export function parseWordLyrics(source) {
  const input = String(source ?? '').slice(0, 200000), result = [];
  const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(input)?.[1] || 0) / 1000;
  for (const raw of input.split(/\r?\n/).slice(0, 4000)) {
    const head = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const base = Number(head[1]), body = raw.slice(head[0].length);
    let words = [], text = '';
    if (body.startsWith('<')) {
      // KRC / Qishui: word offsets relative to the line start, in milliseconds.
      words = [...body.matchAll(/<(-?\d+),(-?\d+)(?:,\d+)?>([^<]*)/g)].map(m =>
        ({ text: m[3], start: (base + Number(m[1])) / 1000 - offset, end: (base + Number(m[1]) + Number(m[2])) / 1000 - offset }));
      text = body.replace(/<[^>]*>/g, '');
    } else if (body.startsWith('(')) {
      // NetEase YRC: absolute word start, duration, flag.
      words = [...body.matchAll(/\((-?\d+),(-?\d+),\d+\)([^()]*)/g)].map(m =>
        ({ text: m[3], start: Number(m[1]) / 1000 - offset, end: (Number(m[1]) + Number(m[2])) / 1000 - offset }));
      text = body.replace(/\([^)]*\)/g, '');
    } else {
      // QQ QRC: text followed by absolute start and duration.
      words = [...body.matchAll(/([^()]+)\((-?\d+),(-?\d+)\)/g)].map(m =>
        ({ text: m[1], start: Number(m[2]) / 1000 - offset, end: (Number(m[2]) + Number(m[3])) / 1000 - offset }));
      text = body.replace(/\([^)]*\)/g, '');
    }
    text = text.trim();
    const time = Math.max(0, base / 1000 - offset);
    if (text) result.push({ time, text, ...(validWords(text, words, time) ? { words } : {}) });
  }
  return result.sort((a, b) => a.time - b.time);
}

export function withWordLyrics(lyrics) {
  if (!lyrics || lyrics.instrumental) return lyrics;
  const parsed = parseWordLyrics(lyrics.original);
  return { ...lyrics, ...(parsed.length ? {
    original: parsed.map(l => `[${String(Math.floor(l.time / 60)).padStart(2, '0')}:${(l.time % 60).toFixed(3).padStart(6, '0')}]${l.text}`).join('\n'),
    wordLines: parsed,
  } : {}) };
}
