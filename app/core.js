(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const norm = (s) => (s || '').toLowerCase().replace(/ё/g, 'е');
  // слова; точка остаётся только между цифрами (17.3)
  const words = (s) =>
    norm(s)
      .replace(/[^a-zа-я0-9.]+/g, ' ')
      .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const isNum = (t) => /^\d+(\.\d+)*$/.test(t);
  const stem = (t) => (isNum(t) ? t : t.length >= 7 ? t.slice(0, -2) : t.length >= 5 ? t.slice(0, -1) : t);

  const SHORT = {
    'конституция': 'Конст.', 'уголовный кодекс': 'УК', 'административный кодекс': 'АК',
    'процессуальный кодекс': 'ПК', 'дорожный кодекс': 'ДК', 'трудовой кодекс': 'ТК', 'финансовый кодекс': 'ФК',
  };
  const shortName = (title) => SHORT[norm(title).trim()] || title.replace(/^Закон\s+/i, 'З. ').slice(0, 28);

  const ART = /^(?:Статья\s+)?(\d{1,3}(?:\.\d+){0,3})\.?\s+(\S.*)$/i;
  const CHAPTER = /^(Глава|Раздел)\s+[\dIVX]+\.?\s*(.*)/i;
  const SKIP = /^(Обновлен|Подписано|Последнее обновление|История изменений|Открыть оригинал|Создать законопроект)/i;

  // text -> массив статей. meta: {key, title, kind, origin}
  function parseDoc(text, meta) {
    const lines = (text || '').replace(/[\u200b\u00ad]/g, '').replace(/\*\*/g, '').split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const recs = []; const seen = {};
    let cur = null, chapter = '';
    for (const line of lines) {
      if (SKIP.test(line)) continue;
      if (CHAPTER.test(line) && line.length < 170) { chapter = line; cur = null; continue; }
      const m = line.match(ART);
      if (m && (/^Статья/i.test(line) || m[1].includes('.'))) {
        const num = m[1];
        seen[num] = (seen[num] || 0) + 1;
        let title = m[2].replace(/^\([A-Z/]+\)\s*/, '').trim();
        if (title.length > 110) title = title.slice(0, 107) + '…';
        cur = { id: meta.key + '|' + num + (seen[num] > 1 ? '#' + seen[num] : ''), kind: meta.kind,
          docTitle: meta.title, doc: meta.short || shortName(meta.title), num, title, chapter,
          lines: [m[2]], origin: meta.origin || '' };
        recs.push(cur);
      } else if (cur) cur.lines.push(line);
    }
    for (const r of recs) {
      const st = r.lines.join(' ').match(/Приоритет розыска:?\s*(★+)/g);
      r.stars = st ? Math.max(...st.map((s) => (s.match(/★/g) || []).length)) : 0;
    }
    return recs;
  }

  function buildIndex(recs) {
    for (const r of recs) {
      r._docw = ' ' + words(r.doc + ' ' + r.docTitle).join(' ');
      r._title = ' ' + words(r.title).join(' ');
      r._body = ' ' + words(r.lines.join(' ')).join(' ') + ' ';
    }
    return recs;
  }

  const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm", RU = 'йцукенгшщзхъфывапролджэячсмить';
  const fixLayout = (q) => q.replace(/[a-z[\];']/gi, (c) => RU[EN.indexOf(c.toLowerCase())] || c);

  function scoreRec(r, qs, phrase) {
    let score = 0;
    for (const x of qs) {
      let s = 0;
      if (x.num) {
        if (r.num === x.t) s = 100; else if (r.num.startsWith(x.t + '.')) s = 40;
        else if (r._body.includes(' ' + x.t + ' ')) s = 2;
      } else {
        if (r._docw.includes(' ' + x.s)) s = 15;
        if (r._title.includes(' ' + x.s)) s = Math.max(s, 12);
        if (r._body.includes(' ' + x.s)) s = Math.max(s, 3);
      }
      if (!s) return 0;
      score += s;
    }
    if (phrase && (r._title.includes(phrase) || r._body.includes(phrase))) score += 10;
    return score;
  }

  // returns {items, partial, tokens}
  function search(recs, q, limit = 80) {
    for (const attempt of [q, fixLayout(q)]) {
      const toks = words(attempt);
      if (!toks.length) return { items: [], partial: false, tokens: [] };
      const qs = toks.map((t) => ({ t, num: isNum(t), s: stem(t) }));
      const phrase = toks.length > 1 ? ' ' + toks.join(' ') : '';
      const hits = [];
      recs.forEach((r, i) => { const s = scoreRec(r, qs, phrase); if (s) hits.push([s, i, r]); });
      if (!hits.length && qs.length > 1) { // запасной вариант: совпадает хотя бы одно слово
        recs.forEach((r, i) => {
          let best = 0;
          for (const x of qs) best += scoreRec(r, [x], '') ? 1 : 0;
          if (best) hits.push([best, i, r]);
        });
        hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        if (hits.length) return { items: hits.slice(0, limit).map((h) => h[2]), partial: true, tokens: toks };
      }
      if (hits.length) {
        hits.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
        return { items: hits.slice(0, limit).map((h) => h[2]), partial: false, tokens: toks };
      }
    }
    return { items: [], partial: false, tokens: words(q) };
  }

  return { parseDoc, buildIndex, search, words, stem, norm, isNum };
});
