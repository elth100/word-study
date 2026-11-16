'use strict';

/* =========================================================
 *  단어 스캔 학습 (iPad 웹앱)
 *  사진 스캔(OCR) → 단어 지우기 → 문제 만들기 → 풀기/채점 → 저장 → 오답 다시 풀기
 * ========================================================= */

/* ===================== 저장소 (IndexedDB) ===================== */
const Store = (() => {
  let dbp = null;
  const mem = new Map(); // IndexedDB를 못 쓰는 환경용 대체
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const req = indexedDB.open('word-scan-study', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function tx(db, mode, fn) {
    return new Promise((res) => {
      try {
        const t = db.transaction('kv', mode);
        const r = fn(t.objectStore('kv'));
        t.oncomplete = () => res(r && r.result);
        t.onerror = () => res(undefined);
      } catch (e) { res(undefined); }
    });
  }
  return {
    async get(key, def) {
      const db = await open();
      if (!db) return mem.has(key) ? mem.get(key) : def;
      const v = await tx(db, 'readonly', (s) => s.get(key));
      return v === undefined ? def : v;
    },
    async set(key, val) {
      const db = await open();
      if (!db) { mem.set(key, val); return; }
      await tx(db, 'readwrite', (s) => s.put(val, key));
    },
    async del(key) {
      const db = await open();
      if (!db) { mem.delete(key); return; }
      await tx(db, 'readwrite', (s) => s.delete(key));
    },
  };
})();

/* ===================== 상태 ===================== */
const DEFAULT_SETTINGS = {
  lenient: true,      // 뜻이 여러 개(쉼표, 슬래시)면 하나만 맞아도 정답
  merge: true,        // 붙어 있는 지운 단어(같은 언어)는 하나의 빈칸으로 묶기
  masterAfter: 2,     // 오답노트에서 연속 N번 맞히면 '완료'
  speakRate: 0.9,
};

const S = {
  docs: [], attempts: [], wrong: [],
  settings: { ...DEFAULT_SETTINGS },
  view: 'home',
  docId: null,
  erase: false,
  showPages: false,
  pages: [],          // 현재 문서의 원본 사진
  quiz: null,         // 현재 문제지
  qs: null,           // 현재 풀이 상태
  backView: 'home',   // 문제 화면에서 돌아갈 곳
  wrongTab: 'active',
  scanTarget: null,   // 'new' 또는 문서 id(페이지 추가)
};

const saveDocs = () => Store.set('docs', S.docs);
const saveAttempts = () => Store.set('attempts', S.attempts);
const saveWrong = () => Store.set('wrong', S.wrong);
const saveSettings = () => Store.set('settings', S.settings);

/* ===================== 유틸 ===================== */
const $ = (sel, root = document) => root.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function busy(on, title, progress, sub) {
  const el = $('#busy');
  el.hidden = !on;
  if (!on) return;
  if (title != null) $('#busyTitle').textContent = title;
  $('#busyBar').style.width = `${Math.round((progress || 0) * 100)}%`;
  if (sub != null) $('#busySub').textContent = sub;
}

function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  return $('#modalBody');
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
}

// 브라우저 confirm 대신 쓰는 확인창
function ask(msg, okLabel = '확인', danger = false) {
  return new Promise((res) => {
    const body = openModal(`
      <h3>${esc(msg)}</h3>
      <div class="actions">
        <button class="btn" data-ans="0">취소</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ans="1">${esc(okLabel)}</button>
      </div>`);
    body.querySelectorAll('[data-ans]').forEach((b) =>
      b.addEventListener('click', () => { closeModal(); res(b.dataset.ans === '1'); }));
  });
}

/* ===================== 텍스트 처리 ===================== */
const RE_HANGUL = /[ㄱ-ㆎ가-힣]/;
const RE_LATIN = /[A-Za-z]/;
const scriptOf = (s) => (RE_HANGUL.test(s) ? 'ko' : RE_LATIN.test(s) ? 'en' : 'other');

// 한 줄을 단어/공백 토큰으로 나눔 (단어에는 줄 안에서의 번호 idx)
function tokenize(line) {
  const out = [];
  const re = /(\s+)|(\S+)/g;
  let m, idx = 0;
  while ((m = re.exec(line))) {
    if (m[1]) out.push({ w: false, text: m[1] });
    else out.push({ w: true, text: m[2], idx: idx++ });
  }
  return out;
}

// "apple," → { lead:'', core:'apple', trail:',' }
function splitPunct(tok) {
  const m = tok.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u);
  return { lead: m[1], core: m[2], trail: m[3] };
}

// 채점용 정규화: 대소문자·공백·문장부호 무시
const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function isCorrect(ans, resp) {
  const r = norm(resp);
  if (!r) return false;
  if (norm(ans) === r) return true;
  if (S.settings.lenient) {
    const parts = ans.split(/[,;/·]|\s+or\s+/i).map(norm).filter(Boolean);
    if (parts.length > 1 && parts.includes(r)) return true;
    const noParen = norm(ans.replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
    if (noParen && noParen === r) return true;
  }
  return false;
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = scriptOf(text) === 'ko' ? 'ko-KR' : 'en-US';
  u.rate = S.settings.speakRate;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
const speakBtn = (t) => (scriptOf(t) === 'en' ? `<button class="speak" data-act="speak" data-t="${esc(t)}" title="발음 듣기">🔊</button>` : '');

// 여러 칸 공백(OCR에서 열 사이 간격)은 넓은 간격으로 표시
const textHtml = (v) => esc(v).replace(/ {2,}|\t+/g, '<span class="gap"></span>');

/* ===================== 문서 ===================== */
const curDoc = () => S.docs.find((d) => d.id === S.docId);

function newDoc(text, title) {
  const doc = {
    id: uid(),
    title: title || `단어장 ${fmtDate(Date.now()).slice(0, 10)}`,
    text: text || '',
    erased: [],
    created: Date.now(),
    updated: Date.now(),
  };
  S.docs.unshift(doc);
  saveDocs();
  return doc;
}

// 텍스트를 고쳐도, 바뀌지 않은 줄의 지우기 표시는 유지
function updateDocText(doc, text) {
  const oldLines = doc.text.split('\n');
  const newLines = text.split('\n');
  doc.erased = doc.erased.filter((k) => {
    const li = +k.split(':')[0];
    return newLines[li] !== undefined && newLines[li] === oldLines[li];
  });
  doc.text = text;
  doc.updated = Date.now();
  saveDocs();
}

/* ===================== 문제 만들기 ===================== */
function rowPlain(segs) {
  return segs.map((s) => (s.k === 'b' ? s.ans : s.v)).join('');
}

function buildQuiz(doc) {
  const erased = new Set(doc.erased);
  const rows = [];
  let bid = 0;
  doc.text.split('\n').forEach((line, li) => {
    const segs = [];
    for (const t of tokenize(line)) {
      if (!t.w) { segs.push({ k: 't', v: t.text }); continue; }
      const p = splitPunct(t.text);
      if (!erased.has(`${li}:${t.idx}`) || !p.core) { segs.push({ k: 't', v: t.text }); continue; }
      const prev = segs[segs.length - 1];
      const prev2 = segs[segs.length - 2];
      // 바로 앞 단어도 지워졌고(공백 하나 사이) 같은 언어면 한 칸으로 묶기: "give up", "포기 하다"
      if (S.settings.merge && !p.lead && prev && prev.k === 't' && prev.v === ' ' &&
          prev2 && prev2.k === 'b' && scriptOf(prev2.ans) === scriptOf(p.core)) {
        segs.pop();
        prev2.ans += ' ' + p.core;
      } else {
        if (p.lead) segs.push({ k: 't', v: p.lead });
        segs.push({ k: 'b', id: `b${bid++}`, ans: p.core });
      }
      if (p.trail) segs.push({ k: 't', v: p.trail });
    }
    rows.push({ segs });
  });
  // 오답노트 식별 키
  for (const r of rows) {
    const plain = rowPlain(r.segs);
    for (const s of r.segs) if (s.k === 'b') s.wkey = `${doc.id}|${plain}|${s.ans}`;
  }
  return { id: uid(), mode: 'normal', docId: doc.id, title: doc.title, rows, created: Date.now() };
}

const quizBlanks = (quiz) => quiz.rows.flatMap((r) => r.segs.filter((s) => s.k === 'b'));

// 한 줄에서 특정 빈칸만 남기고 나머지 빈칸은 정답 글자로 채움 (오답노트용)
function rowForBlank(row, blank) {
  return row.segs.map((s) => {
    if (s.k !== 'b') return { k: 't', v: s.v };
    if (s.id === blank.id) return { k: 'b', ans: s.ans };
    return { k: 't', v: s.ans };
  });
}

function buildReviewQuiz(items, title) {
  let n = 0;
  const rows = items.map((it) => ({
    src: it.docTitle,
    wc: it.wrongCount,
    segs: it.segs.map((s) => (s.k === 'b' ? { k: 'b', id: `b${n++}`, ans: s.ans, wkey: it.key } : { ...s })),
  }));
  return { id: uid(), mode: 'review', docId: null, title, rows, created: Date.now() };
}

function startQuiz(quiz, backView, doShuffle = false) {
  S.quiz = quiz;
  const order = quiz.rows.map((_, i) => i);
  S.qs = {
    responses: {}, results: {}, graded: false, saved: false, viewOnly: false,
    hint: false, onlyBlanks: quiz.mode === 'review',
    order: doShuffle ? shuffle(order) : order,
  };
  S.backView = backView;
  go('quiz', true);
}

function gradeQuiz() {
  const { quiz, qs } = S;
  for (const b of quizBlanks(quiz)) {
    qs.results[b.id] = { ok: isCorrect(b.ans, qs.responses[b.id]) };
  }
  qs.graded = true;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scoreOf(quiz, qs) {
  const blanks = quizBlanks(quiz);
  const correct = blanks.filter((b) => qs.results[b.id]?.ok).length;
  const total = blanks.length;
  return { correct, total, score: total ? Math.round((correct / total) * 100) : 0 };
}

function saveAttempt() {
  const { quiz, qs } = S;
  if (!qs.graded || qs.saved) return;
  const sc = scoreOf(quiz, qs);
  S.attempts.unshift({
    id: uid(), date: Date.now(), title: quiz.title, mode: quiz.mode, docId: quiz.docId,
    quiz, responses: { ...qs.responses }, results: { ...qs.results }, order: qs.order.slice(), ...sc,
  });
  saveAttempts();

  // 오답노트 갱신
  const now = Date.now();
  let added = 0, mastered = 0;
  quiz.rows.forEach((row) => {
    for (const b of row.segs) {
      if (b.k !== 'b' || !b.wkey) continue;
      const ok = qs.results[b.id]?.ok;
      let item = S.wrong.find((w) => w.key === b.wkey);
      if (!ok) {
        if (item) {
          item.wrongCount++; item.streak = 0; item.mastered = false; item.lastWrong = now;
        } else {
          S.wrong.push({
            key: b.wkey, ans: b.ans, segs: rowForBlank(row, b),
            docTitle: row.src || quiz.title, wrongCount: 1, streak: 0, mastered: false,
            created: now, lastWrong: now,
          });
          added++;
        }
      } else if (item && !item.mastered) {
        item.streak++;
        if (item.streak >= S.settings.masterAfter) { item.mastered = true; item.masteredAt = now; mastered++; }
      }
    }
  });
  saveWrong();
  qs.saved = true;
  render();
  let msg = '저장했어요 💾';
  if (added) msg += ` · 새 오답 ${added}개 오답노트에 추가`;
  if (mastered) msg += ` · ${mastered}개 완전히 외웠어요 🎉`;
  toast(msg, 3500);
}

/* ===================== 화면 전환 ===================== */
async function go(view, force = false) {
  if (!force && S.view === 'quiz' && S.qs && S.qs.graded && !S.qs.saved && !S.qs.viewOnly) {
    const ok = await ask('채점 결과를 저장하지 않았어요. 저장하지 않고 나갈까요?', '저장 안 하고 나가기', true);
    if (!ok) return;
  }
  if (view !== 'doc') S.erase = false;
  S.view = view;
  render();
  window.scrollTo(0, 0);
}

function render() {
  const top = $('#topbar');
  const app = $('#app');
  const v = VIEWS[S.view] || VIEWS.home;
  top.innerHTML = v.top();
  app.innerHTML = v.body();
  v.after && v.after();
}

/* ===================== 화면들 ===================== */
const VIEWS = {};

/* ---------- 홈 ---------- */
VIEWS.home = {
  top: () => `
    <h1>📘 단어 스캔 학습</h1>
    <div class="spacer"></div>
    <button class="btn" data-act="backup">💾 백업</button>
    <button class="btn" data-act="settings">⚙️ 설정</button>`,
  body: () => {
    const active = S.wrong.filter((w) => !w.mastered).length;
    const done = S.wrong.length - active;
    const avg = S.attempts.length ? Math.round(S.attempts.reduce((a, b) => a + b.score, 0) / S.attempts.length) : '-';
    const docs = S.docs.map((d) => {
      const lines = d.text.split('\n').filter((l) => l.trim()).length;
      return `
        <div class="item">
          <div class="main" data-act="openDoc" data-id="${d.id}">
            <div class="t">${esc(d.title)}</div>
            <div class="s">${fmtDate(d.updated)} · ${lines}줄 · 지운 단어 ${d.erased.length}개</div>
          </div>
          <button class="btn small" data-act="quickQuiz" data-id="${d.id}" ${d.erased.length ? '' : 'disabled'}>📝 문제 풀기</button>
          <button class="btn small" data-act="openDoc" data-id="${d.id}">열기</button>
          <button class="btn small danger" data-act="delDoc" data-id="${d.id}">🗑</button>
        </div>`;
    }).join('');
    const recent = S.attempts.slice(0, 5).map(attemptItem).join('');
    return `
      <div class="hero-actions">
        <button class="hero-btn primary" data-act="scanNew">
          <span class="ico">📷</span><b>사진으로 스캔</b><span>단어책을 찍거나 사진을 불러와 글자를 읽어요</span>
        </button>
        <button class="hero-btn" data-act="typeNew">
          <span class="ico">⌨️</span><b>직접 입력</b><span>단어 목록을 붙여넣거나 직접 써요</span>
        </button>
        <button class="hero-btn" data-act="reviewWrong">
          <span class="ico">❌</span><b>틀린 문제 다시 풀기 ${active ? `<span class="badge">${active}</span>` : ''}</b>
          <span>오답노트에 모인 문제만 풀어요</span>
        </button>
        <button class="hero-btn" data-act="goWrong">
          <span class="ico">📒</span><b>오답노트</b><span>틀린 단어 모아보기 · 발음 듣기</span>
        </button>
      </div>

      <div class="stats">
        <div class="stat"><div class="v">${S.docs.length}</div><div class="k">단어장</div></div>
        <div class="stat"><div class="v">${S.attempts.length}</div><div class="k">푼 시험</div></div>
        <div class="stat"><div class="v">${avg}</div><div class="k">평균 점수</div></div>
        <div class="stat"><div class="v">${active}</div><div class="k">복습할 오답</div></div>
        <div class="stat"><div class="v">${done}</div><div class="k">외운 단어</div></div>
      </div>

      <h2 class="section">📚 내 단어장</h2>
      ${docs ? `<div class="list">${docs}</div>` : '<div class="empty">아직 단어장이 없어요. 위의 <b>사진으로 스캔</b>을 눌러 시작하세요.</div>'}

      <h2 class="section">📊 최근 학습 기록 <span class="spacer"></span>
        ${S.attempts.length > 5 ? '<button class="btn small" data-act="goHistory">전체 보기</button>' : ''}</h2>
      ${recent ? `<div class="list">${recent}</div>` : '<div class="empty">채점 후 <b>저장</b>하면 여기에 기록이 쌓여요.</div>'}`;
  },
};

function attemptItem(a) {
  return `
    <div class="item">
      <div class="main" data-act="openAttempt" data-id="${a.id}">
        <div class="t">${a.mode === 'review' ? '❌ ' : '📝 '}${esc(a.title)}</div>
        <div class="s">${fmtDate(a.date)} · ${a.correct}/${a.total} 정답</div>
      </div>
      <span class="score-pill">${a.score}점</span>
      <button class="btn small danger" data-act="delAttempt" data-id="${a.id}">🗑</button>
    </div>`;
}

/* ---------- 문서 (지우기) ---------- */
VIEWS.doc = {
  top: () => {
    const d = curDoc();
    return `
      <button class="btn" data-act="home">← 홈</button>
      <input class="title-input" id="docTitle" value="${esc(d.title)}" aria-label="단어장 이름" />
      <div class="spacer"></div>
      <button class="btn" data-act="scanAdd">📷 페이지 추가</button>
      <button class="btn" data-act="editText">✎ 텍스트 수정</button>
      <button class="btn ${S.showPages ? 'on' : ''}" data-act="togglePages">🖼 원본</button>
      <div style="flex-basis:100%;height:0"></div>
      <button class="btn ${S.erase ? 'on' : ''}" data-act="toggleErase">🧽 ${S.erase ? '지우기 끝내기' : '지우기'}</button>
      <button class="btn small" data-act="eraseAll" data-s="en">영어 전부 지우기</button>
      <button class="btn small" data-act="eraseAll" data-s="ko">한글 전부 지우기</button>
      <button class="btn small" data-act="eraseAll" data-s="none">모두 되돌리기</button>
      <div class="spacer"></div>
      <button class="btn primary" data-act="makeQuiz">📝 문제 만들기 (<span id="eraseCount">${d.erased.length}</span>)</button>`;
  },
  body: () => {
    const d = curDoc();
    const erased = new Set(d.erased);
    const lines = d.text.split('\n').map((line, li) => docLineHtml(line, li, erased)).join('');
    const pages = S.showPages
      ? `<div class="pages">${S.pages.length ? S.pages.map((p) => `<img src="${p}" alt="원본 사진" />`).join('') : '<div class="empty">저장된 원본 사진이 없어요.</div>'}</div>`
      : '';
    const hint = S.erase
      ? `<div class="hint-bar erase">🧽 <b>지우기 모드</b> — 애플 펜슬(또는 손가락)로 단어를 <b>한 번 탭</b>하면 그 단어가 지워져요. 다시 탭하면 되돌아와요. 펜슬로 <b>쓱 그으면</b> 여러 단어를 한꺼번에 지울 수 있어요.</div>`
      : `<div class="hint-bar">💡 <b>🧽 지우기</b>를 누른 뒤 가리고 싶은 단어를 탭하세요. 지금은 영어 단어를 탭하면 <b>발음</b>을 들려줘요. 잘못 읽힌 글자는 <b>✎ 텍스트 수정</b>으로 고칠 수 있어요.</div>`;
    return `${hint}${pages}<div class="doc ${S.erase ? 'erasing' : ''}" id="docText">${lines || '<div class="empty">내용이 없어요. ✎ 텍스트 수정을 눌러 입력하세요.</div>'}</div>`;
  },
  after: bindDocEvents,
};

function docLineHtml(line, li, erased) {
  if (!line.trim()) return '<div class="line">&nbsp;</div>';
  const html = tokenize(line).map((t) => {
    if (!t.w) return t.text.length >= 2 || t.text.includes('\t') ? '<span class="gap"></span>' : ' ';
    const k = `${li}:${t.idx}`;
    const p = splitPunct(t.text);
    return `<span class="tok${erased.has(k) ? ' erased' : ''}" data-k="${k}" data-e="${p.core ? 1 : 0}" data-c="${esc(p.core)}">${esc(t.text)}</span>`;
  }).join('');
  return `<div class="line">${html}</div>`;
}

let eraseDrag = null;
function bindDocEvents() {
  const box = $('#docText');
  if (!box) return;
  const d = curDoc();
  $('#docTitle').addEventListener('change', (e) => {
    d.title = e.target.value.trim() || d.title;
    d.updated = Date.now();
    saveDocs();
  });

  // 펜슬로 그을 때는 화면이 스크롤되지 않게 (손가락 스크롤은 그대로)
  const blockStylus = (e) => {
    if (S.erase && [...e.touches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  };
  box.addEventListener('touchstart', blockStylus, { passive: false });
  box.addEventListener('touchmove', blockStylus, { passive: false });

  const set = new Set(d.erased);
  const apply = (tok, mode) => {
    if (!tok || tok.dataset.e !== '1' || eraseDrag.seen.has(tok.dataset.k)) return;
    eraseDrag.seen.add(tok.dataset.k);
    tok.classList.toggle('erased', mode);
    if (mode) set.add(tok.dataset.k); else set.delete(tok.dataset.k);
    $('#eraseCount').textContent = set.size;
  };

  box.addEventListener('pointerdown', (e) => {
    if (!S.erase) return;
    const tok = e.target.closest('.tok');
    eraseDrag = {
      mode: tok ? !tok.classList.contains('erased') : true,
      seen: new Set(),
      drag: e.pointerType !== 'touch', // 펜/마우스만 긋기 지우기
      apply,
      commit: () => { d.erased = [...set]; d.updated = Date.now(); saveDocs(); },
    };
    if (tok) apply(tok, eraseDrag.mode);
  });
  box.addEventListener('pointermove', (e) => {
    if (!eraseDrag || !eraseDrag.drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tok = el && el.closest && el.closest('.tok');
    if (tok && box.contains(tok)) eraseDrag.apply(tok, eraseDrag.mode);
  });
  box.addEventListener('click', (e) => {
    if (S.erase) return;
    const tok = e.target.closest('.tok');
    if (tok && tok.dataset.c) speak(tok.dataset.c);
  });
}
const endErase = () => { if (eraseDrag) { eraseDrag.commit(); eraseDrag = null; } };
window.addEventListener('pointerup', endErase);
window.addEventListener('pointercancel', endErase);

/* ---------- 문제 ---------- */
VIEWS.quiz = {
  top: () => {
    const { quiz, qs } = S;
    const back = qs.viewOnly ? '← 기록' : S.backView === 'doc' ? '← 문서' : '← 뒤로';
    let btns;
    if (qs.viewOnly) {
      btns = `<button class="btn" data-act="retryQuiz">🔁 이 시험 다시 풀기</button>
              ${quiz.mode === 'normal' && S.docs.some((d) => d.id === quiz.docId) ? '<button class="btn" data-act="openQuizDoc">📄 단어장 열기</button>' : ''}`;
    } else if (!qs.graded) {
      btns = `
        <button class="btn ${qs.hint ? 'on' : ''}" data-act="toggleHint">💡 힌트</button>
        <button class="btn" data-act="shuffleQuiz">🔀 섞기</button>
        <button class="btn ${qs.onlyBlanks ? 'on' : ''}" data-act="toggleOnlyBlanks">빈칸 줄만</button>
        <button class="btn primary" data-act="grade">✅ 문제 풀이 (채점)</button>`;
    } else {
      const wrongN = quizBlanks(quiz).filter((b) => !qs.results[b.id]?.ok).length;
      btns = `
        <button class="btn ${qs.saved ? '' : 'ok'}" data-act="saveAttempt" ${qs.saved ? 'disabled' : ''}>💾 ${qs.saved ? '저장됨' : '저장'}</button>
        <button class="btn" data-act="retryQuiz">🔁 다시 풀기</button>
        <button class="btn" data-act="retryWrongNow" ${wrongN ? '' : 'disabled'}>❌ 틀린 것만 다시 (${wrongN})</button>`;
    }
    return `
      <button class="btn" data-act="quizBack">${back}</button>
      <h1>${quiz.mode === 'review' ? '❌ ' : '📝 '}${esc(quiz.title)}</h1>
      <div class="spacer"></div>${btns}`;
  },
  body: () => {
    const { quiz, qs } = S;
    let banner = '';
    if (qs.graded) {
      const sc = scoreOf(quiz, qs);
      const msg = sc.score >= 90 ? '훌륭해요! 🎉' : sc.score >= 70 ? '잘했어요! 👍' : sc.score >= 50 ? '조금만 더 힘내요! 💪' : '틀린 문제를 다시 풀어봐요 📚';
      banner = `
        <div class="result-banner">
          <div class="big">${sc.score}점</div>
          <div><div class="msg">${msg}</div><div class="sub">${sc.total}문제 중 ${sc.correct}개 정답 · 틀린 문제는 옆에 정답이 표시돼요</div></div>
          <div class="spacer"></div>
          ${!qs.saved && !qs.viewOnly ? '<div class="sub">💾 <b>저장</b>을 누르면 기록과 오답노트에 저장돼요</div>' : ''}
        </div>`;
    } else {
      banner = `<div class="hint-bar">✏️ 네모 칸을 누르고 <b>키보드</b>로 쓰거나, <b>애플 펜슬</b>로 칸 위에 바로 쓰세요(손글씨 입력). 칸 옆 ✏️ 버튼을 누르면 큰 손글씨 패드가 열려요.</div>`;
    }
    const rows = qs.order.map((i) => quiz.rows[i])
      .filter((r) => !qs.onlyBlanks || r.segs.some((s) => s.k === 'b'))
      .map((r) => {
        const inner = r.segs.map((s) => (s.k === 'b' ? blankHtml(s) : textHtml(s.v))).join('');
        const ctx = quiz.mode === 'review' ? `<span class="ctx">출처: ${esc(r.src || '')} · 틀린 횟수 ${r.wc || 1}회</span>` : '';
        return `<div class="qrow">${inner || '&nbsp;'}${ctx}</div>`;
      }).join('');
    return `${banner}<div class="quiz">${rows}</div>`;
  },
};

function blankHtml(b) {
  const { qs } = S;
  const resp = qs.responses[b.id] || '';
  const lang = scriptOf(b.ans) === 'ko' ? 'ko' : 'en';
  const units = [...b.ans].reduce((n, ch) => n + (RE_HANGUL.test(ch) ? 1.8 : 1), 0);
  const width = Math.max(5.5, Math.min(18, units * 0.62 + 2.2));
  let ph = '';
  if (qs.hint && !qs.graded) {
    const first = [...b.ans][0];
    ph = lang === 'en' ? first + ' _'.repeat(Math.max(0, b.ans.length - 1)) : `${first}…`;
  }
  let cls = 'blank', extra = '';
  if (qs.graded) {
    const r = qs.results[b.id] || {};
    cls += r.ok ? ' ok' : ' bad';
    extra = `<span class="mark">${r.ok ? '○' : '✕'}</span>`;
    if (!r.ok) {
      extra += `<span class="answer">${esc(b.ans)}${speakBtn(b.ans)}</span>`;
      if (!qs.viewOnly) extra += `<button class="mini" data-act="accept" data-id="${b.id}">정답 인정</button>`;
    } else {
      extra += speakBtn(b.ans);
      if (r.manual) extra += '<span class="mini" style="cursor:default">인정됨</span>';
    }
  }
  return `<span class="${cls}">
    <input type="text" data-id="${b.id}" lang="${lang}" value="${esc(resp)}" placeholder="${esc(ph)}"
      style="width:${width.toFixed(1)}em" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
      ${qs.graded ? 'readonly' : ''} />
    ${qs.graded ? '' : `<button class="pad-btn" data-act="pad" data-id="${b.id}" title="손글씨 패드">✏️</button>`}
    ${extra}</span>`;
}

// 입력 내용 기억 + 엔터로 다음 칸 이동
document.addEventListener('input', (e) => {
  if (e.target.matches('.blank input') && S.qs && !S.qs.graded) S.qs.responses[e.target.dataset.id] = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('.blank input')) return;
  e.preventDefault();
  const all = [...document.querySelectorAll('.blank input:not([readonly])')];
  const next = all[all.indexOf(e.target) + 1];
  if (next) next.focus(); else e.target.blur();
});

/* ---------- 오답노트 ---------- */
VIEWS.wrong = {
  top: () => {
    const active = S.wrong.filter((w) => !w.mastered).length;
    return `
      <button class="btn" data-act="home">← 홈</button>
      <h1>📒 오답노트</h1>
      <div class="spacer"></div>
      <button class="btn primary" data-act="reviewWrong" ${active ? '' : 'disabled'}>❌ 틀린 문제 다시 풀기 (${active})</button>`;
  },
  body: () => {
    const active = S.wrong.filter((w) => !w.mastered);
    const done = S.wrong.filter((w) => w.mastered);
    const list = (S.wrongTab === 'active' ? active : done)
      .slice().sort((a, b) => b.wrongCount - a.wrongCount || b.lastWrong - a.lastWrong);
    const items = list.map((w) => {
      const ctx = w.segs.map((s) => (s.k === 'b' ? `<span class="ans">${esc(s.ans)}</span>` : textHtml(s.v))).join('');
      return `
        <div class="item">
          <div class="main" style="cursor:default">
            <div class="wrong-ctx">${ctx}</div>
            <div class="s">${esc(w.docTitle)} · 틀린 횟수 ${w.wrongCount}회 · 연속 정답 ${Math.min(w.streak, S.settings.masterAfter)}/${S.settings.masterAfter}</div>
          </div>
          ${speakBtn(w.ans)}
          ${w.mastered ? `<button class="btn small" data-act="unmaster" data-k="${esc(w.key)}">다시 복습</button>` : ''}
          <button class="btn small danger" data-act="delWrong" data-k="${esc(w.key)}">🗑</button>
        </div>`;
    }).join('');
    return `
      <div class="hint-bar">💡 틀린 문제는 자동으로 모여요. 다시 풀어서 <b>연속 ${S.settings.masterAfter}번</b> 맞히면 '외운 단어'로 옮겨져요.</div>
      <div class="tabs">
        <button class="btn ${S.wrongTab === 'active' ? 'primary' : ''}" data-act="wrongTab" data-t="active">복습할 문제 (${active.length})</button>
        <button class="btn ${S.wrongTab === 'done' ? 'primary' : ''}" data-act="wrongTab" data-t="done">외운 단어 (${done.length})</button>
      </div>
      ${items ? `<div class="list">${items}</div>` : `<div class="empty">${S.wrongTab === 'active' ? '복습할 오답이 없어요 👏' : '아직 완전히 외운 단어가 없어요.'}</div>`}`;
  },
};

/* ---------- 학습 기록 ---------- */
VIEWS.history = {
  top: () => `<button class="btn" data-act="home">← 홈</button><h1>📊 학습 기록</h1><div class="spacer"></div>`,
  body: () => (S.attempts.length ? `<div class="list">${S.attempts.map(attemptItem).join('')}</div>` : '<div class="empty">기록이 없어요.</div>'),
};

/* ===================== 버튼 동작 ===================== */
const ACTIONS = {
  home: () => go('home'),
  goWrong: () => go('wrong'),
  goHistory: () => go('history'),
  speak: (el) => speak(el.dataset.t),

  scanNew: () => pickImage('new'),
  scanAdd: () => pickImage(S.docId),
  typeNew: () => openTextEditor(null),
  editText: () => openTextEditor(curDoc()),

  openDoc: (el) => openDoc(el.dataset.id),
  async delDoc(el) {
    const d = S.docs.find((x) => x.id === el.dataset.id);
    if (!d || !(await ask(`'${d.title}' 단어장을 삭제할까요? (학습 기록과 오답노트는 남아요)`, '삭제', true))) return;
    S.docs = S.docs.filter((x) => x.id !== d.id);
    saveDocs();
    Store.del(`img:${d.id}`);
    render();
  },
  quickQuiz(el) {
    const d = S.docs.find((x) => x.id === el.dataset.id);
    if (d) startQuiz(buildQuiz(d), 'home');
  },

  togglePages: () => { S.showPages = !S.showPages; render(); },
  toggleErase: () => { S.erase = !S.erase; render(); },
  eraseAll(el) {
    const d = curDoc();
    const s = el.dataset.s;
    if (s === 'none') d.erased = [];
    else {
      const set = new Set(d.erased);
      d.text.split('\n').forEach((line, li) => {
        for (const t of tokenize(line)) {
          if (!t.w) continue;
          const core = splitPunct(t.text).core;
          if (core && scriptOf(core) === s) set.add(`${li}:${t.idx}`);
        }
      });
      d.erased = [...set];
    }
    d.updated = Date.now();
    saveDocs();
    render();
  },
  makeQuiz() {
    const d = curDoc();
    if (!d.erased.length) {
      toast('먼저 🧽 지우기를 눌러 문제로 낼 단어를 지워주세요');
      return;
    }
    startQuiz(buildQuiz(d), 'doc');
  },

  quizBack: () => go(S.qs.viewOnly ? 'history' : S.backView),
  grade: () => gradeQuiz(),
  toggleHint: () => { S.qs.hint = !S.qs.hint; render(); },
  toggleOnlyBlanks: () => { S.qs.onlyBlanks = !S.qs.onlyBlanks; render(); },
  shuffleQuiz: () => { S.qs.order = shuffle(S.qs.order); render(); toast('문제 순서를 섞었어요 🔀'); },
  accept(el) {
    const r = S.qs.results[el.dataset.id];
    if (!r) return;
    r.ok = true; r.manual = true;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  saveAttempt: () => saveAttempt(),
  async retryQuiz() {
    if (S.qs.graded && !S.qs.saved && !S.qs.viewOnly &&
        !(await ask('채점 결과를 저장하지 않았어요. 저장하지 않고 다시 풀까요?', '다시 풀기', true))) return;
    const back = S.qs.viewOnly ? 'history' : S.backView;
    const q = { ...S.quiz, id: uid() };
    startQuiz(q, back, S.quiz.mode === 'review');
  },
  async retryWrongNow() {
    const { quiz, qs } = S;
    if (!qs.saved && !(await ask('지금 결과를 먼저 저장할까요? (저장해야 오답노트에 남아요)', '저장하고 계속'))) return;
    if (!qs.saved) saveAttempt();
    const items = [];
    quiz.rows.forEach((row) => row.segs.forEach((b) => {
      if (b.k === 'b' && !qs.results[b.id]?.ok) {
        items.push({ key: b.wkey, segs: rowForBlank(row, b), docTitle: row.src || quiz.title, wrongCount: 1 });
      }
    }));
    startQuiz(buildReviewQuiz(items, `${quiz.title} - 틀린 문제`), S.backView, true);
  },
  openQuizDoc: () => openDoc(S.quiz.docId),

  reviewWrong() {
    const items = S.wrong.filter((w) => !w.mastered);
    if (!items.length) { toast('복습할 틀린 문제가 없어요 👏'); return; }
    startQuiz(buildReviewQuiz(items, '틀린 문제 다시 풀기'), S.view === 'wrong' ? 'wrong' : 'home', true);
  },
  wrongTab: (el) => { S.wrongTab = el.dataset.t; render(); },
  async delWrong(el) {
    if (!(await ask('이 문제를 오답노트에서 지울까요?', '삭제', true))) return;
    S.wrong = S.wrong.filter((w) => w.key !== el.dataset.k);
    saveWrong();
    render();
  },
  unmaster(el) {
    const w = S.wrong.find((x) => x.key === el.dataset.k);
    if (w) { w.mastered = false; w.streak = 0; saveWrong(); render(); }
  },

  openAttempt(el) {
    const a = S.attempts.find((x) => x.id === el.dataset.id);
    if (!a) return;
    S.quiz = a.quiz;
    S.qs = {
      responses: a.responses, results: a.results, graded: true, saved: true, viewOnly: true,
      hint: false, onlyBlanks: a.mode === 'review', order: a.order || a.quiz.rows.map((_, i) => i),
    };
    S.backView = 'history';
    go('quiz');
  },
  async delAttempt(el) {
    if (!(await ask('이 기록을 삭제할까요?', '삭제', true))) return;
    S.attempts = S.attempts.filter((a) => a.id !== el.dataset.id);
    saveAttempts();
    render();
  },

  pad: (el) => openPad(el.dataset.id),
  settings: () => openSettings(),
  backup: () => openBackup(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' && !$('#modal').dataset.lock) closeModal(); });

async function openDoc(id) {
  S.docId = id;
  S.erase = false;
  S.pages = await Store.get(`img:${id}`, []);
  go('doc', true);
}

/* ===================== 텍스트 입력/수정 ===================== */
function openTextEditor(doc) {
  const body = openModal(`
    <h3>${doc ? '✎ 텍스트 수정' : '⌨️ 단어 직접 입력'}</h3>
    <p>한 줄에 한 항목씩 적어주세요. 예) <code>apple   사과</code> · 띄어쓰기로 단어가 나뉘어요.${doc ? ' 고친 줄의 지우기 표시는 초기화돼요.' : ''}</p>
    <textarea id="editText" spellcheck="false" placeholder="apple   사과&#10;banana   바나나&#10;give up   포기하다">${esc(doc ? doc.text : '')}</textarea>
    <div class="actions">
      <button class="btn" id="edCancel">취소</button>
      <button class="btn primary" id="edSave">저장</button>
    </div>`);
  body.querySelector('#edCancel').onclick = closeModal;
  body.querySelector('#edSave').onclick = () => {
    const text = body.querySelector('#editText').value.replace(/\r/g, '').replace(/\s+$/, '');
    closeModal();
    if (doc) { updateDocText(doc, text); render(); }
    else if (text.trim()) openDoc(newDoc(text).id);
  };
}

/* ===================== 사진 → 자르기 → OCR ===================== */
function pickImage(target) {
  S.scanTarget = target;
  const inp = $('#fileImage');
  inp.value = '';
  inp.click();
}

$('#fileImage').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const img = await loadImage(f);
    openCropper(img);
  } catch (err) {
    toast('사진을 열 수 없어요. 다른 사진으로 시도해 주세요.');
  }
});

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = rej;
    img.src = url;
  });
}

// 큰 사진은 메모리 절약을 위해 긴 변 3000px로 줄임
function toCanvas(img, maxSide = 3000) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const sc = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * sc);
  c.height = Math.round(h * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function rotate90(src) {
  const c = document.createElement('canvas');
  c.width = src.height;
  c.height = src.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

function openCropper(img) {
  let src = toCanvas(img);
  let rect = null; // 화면 좌표 기준 선택 영역
  const body = openModal(`
    <h3>📷 읽을 영역 선택</h3>
    <p>단어가 있는 부분만 손가락/펜슬로 드래그해서 고르면 더 정확하게 읽어요. (선택하지 않으면 전체를 읽어요)</p>
    <div class="crop-wrap"><canvas id="cropCv"></canvas></div>
    <div class="actions">
      <button class="btn" id="cRot">↻ 회전</button>
      <button class="btn" id="cAll">전체 선택</button>
      <div class="spacer" style="flex:1"></div>
      <button class="btn" id="cCancel">취소</button>
      <button class="btn primary" id="cGo">🔍 글자 읽기</button>
    </div>`);
  $('#modal').dataset.lock = '1';
  const cv = body.querySelector('#cropCv');
  const ctx = cv.getContext('2d');

  function layout() {
    const maxW = Math.min(body.clientWidth - 40, 900);
    const maxH = window.innerHeight * 0.58;
    const sc = Math.min(maxW / src.width, maxH / src.height, 1);
    cv.width = Math.round(src.width * sc);
    cv.height = Math.round(src.height * sc);
    rect = null;
    draw();
  }
  function draw() {
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    if (!rect) return;
    const r = normRect(rect);
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(0, 0, cv.width, r.y);
    ctx.fillRect(0, r.y + r.h, cv.width, cv.height - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, cv.width - r.x - r.w, r.h);
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  const normRect = (r) => ({
    x: Math.max(0, Math.min(r.x0, r.x1)), y: Math.max(0, Math.min(r.y0, r.y1)),
    w: Math.min(cv.width, Math.max(r.x0, r.x1)) - Math.max(0, Math.min(r.x0, r.x1)),
    h: Math.min(cv.height, Math.max(r.y0, r.y1)) - Math.max(0, Math.min(r.y0, r.y1)),
  });
  const pos = (e) => {
    const b = cv.getBoundingClientRect();
    return { x: ((e.clientX - b.left) * cv.width) / b.width, y: ((e.clientY - b.top) * cv.height) / b.height };
  };
  let dragging = false;
  cv.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    rect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pos(e);
    rect.x1 = p.x; rect.y1 = p.y;
    draw();
  });
  cv.addEventListener('pointerup', () => {
    dragging = false;
    if (rect) { const r = normRect(rect); if (r.w < 20 || r.h < 20) rect = null; }
    draw();
  });

  const close = () => { delete $('#modal').dataset.lock; closeModal(); };
  body.querySelector('#cRot').onclick = () => { src = rotate90(src); layout(); };
  body.querySelector('#cAll').onclick = () => { rect = null; draw(); };
  body.querySelector('#cCancel').onclick = close;
  body.querySelector('#cGo').onclick = async () => {
    let crop = src;
    if (rect) {
      const r = normRect(rect);
      const k = src.width / cv.width;
      crop = document.createElement('canvas');
      crop.width = Math.round(r.w * k);
      crop.height = Math.round(r.h * k);
      crop.getContext('2d').drawImage(src, r.x * k, r.y * k, crop.width, crop.height, 0, 0, crop.width, crop.height);
    }
    close();
    await scanCanvas(crop);
  };
  requestAnimationFrame(layout);
}

/* ---------- OCR 엔진 ---------- */
let ocrWorkerP = null;
let ocrLogger = null;
function getWorker() {
  if (!window.Tesseract) return Promise.reject(new Error('OCR 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.'));
  if (!ocrWorkerP) {
    ocrWorkerP = Tesseract.createWorker(['eng', 'kor'], 1, {
      logger: (m) => ocrLogger && ocrLogger(m),
    }).catch((e) => { ocrWorkerP = null; throw e; });
  }
  return ocrWorkerP;
}

const OCR_STATUS = {
  'loading tesseract core': '인식 엔진 불러오는 중…',
  'initializing tesseract': '인식 엔진 준비 중…',
  'loading language traineddata': '영어·한글 인식 데이터 내려받는 중…',
  'initializing api': '인식 준비 중…',
  'recognizing text': '글자를 읽는 중…',
};

// 흑백 변환 + 대비 강화 + 적당한 크기로 조정
function preprocess(src) {
  const long = Math.max(src.width, src.height);
  const sc = long > 2600 ? 2600 / long : src.width < 1200 ? 1200 / src.width : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * sc);
  c.height = Math.round(src.height * sc);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = g;
    hist[g]++;
  }
  const n = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  const range = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

// OCR 결과(줄/단어 위치)를 표 형태의 단어장에 맞게 텍스트로 재구성
function ocrToText(data) {
  const lines = (data.lines || [])
    .map((l) => ({
      b: l.bbox,
      words: (l.words || []).filter((w) => {
        const t = (w.text || '').trim();
        if (!t) return false;
        if (!/[\p{L}\p{N}]/u.test(t) && w.confidence < 50) return false; // 잡티 제거
        return true;
      }),
    }))
    .filter((l) => l.words.length);
  if (!lines.length) return (data.text || '').trim();

  // 같은 높이에 있는 줄(왼쪽 영어 열 + 오른쪽 뜻 열)을 한 줄로 합침
  lines.sort((a, b) => (a.b.y0 + a.b.y1) - (b.b.y0 + b.b.y1));
  const rows = [];
  for (const l of lines) {
    const h = l.b.y1 - l.b.y0;
    const r = rows.find((r) => {
      const ov = Math.min(r.y1, l.b.y1) - Math.max(r.y0, l.b.y0);
      return ov > 0.5 * Math.min(h, r.y1 - r.y0) && !r.lines.some((o) => o.b.x0 < l.b.x1 && l.b.x0 < o.b.x1);
    });
    if (r) { r.lines.push(l); r.y0 = Math.min(r.y0, l.b.y0); r.y1 = Math.max(r.y1, l.b.y1); }
    else rows.push({ y0: l.b.y0, y1: l.b.y1, lines: [l] });
  }
  rows.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));

  return rows.map((r) => {
    r.lines.sort((a, b) => a.b.x0 - b.b.x0);
    const hs = r.lines.map((l) => l.b.y1 - l.b.y0).sort((a, b) => a - b);
    const h = hs[hs.length >> 1] || 20;
    let out = '', prev = null;
    for (const w of r.lines.flatMap((l) => l.words)) {
      const t = w.text.trim();
      if (prev) {
        const gap = w.bbox.x0 - prev.bbox.x1;
        const pt = prev.text.trim();
        if (gap > 1.2 * h) out += '   '; // 열 사이 간격
        else if (gap < 0.12 * h && RE_HANGUL.test(pt.slice(-1)) && RE_HANGUL.test(t[0])) out += ''; // 잘못 띄어진 한글 붙이기
        else out += ' ';
      }
      out += t;
      prev = w;
    }
    return out;
  }).join('\n');
}

async function scanCanvas(canvas) {
  busy(true, '인식 엔진 준비 중…', 0, '처음 한 번은 인식 데이터를 내려받느라 시간이 조금 걸려요.');
  ocrLogger = (m) => {
    const title = OCR_STATUS[m.status] || '처리 중…';
    busy(true, title, m.progress, null);
  };
  try {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    busy(true, '글자를 읽는 중…', 0, '사진 크기에 따라 10~40초 정도 걸려요.');
    const { data } = await worker.recognize(preprocess(canvas));
    const text = ocrToText(data);
    busy(false);
    if (!text.trim()) { toast('글자를 찾지 못했어요. 더 밝고 반듯하게 찍어 보세요.', 3500); return; }

    // 원본 사진(축소본) 저장
    const thumb = (() => {
      const sc = Math.min(1, 1400 / Math.max(canvas.width, canvas.height));
      const c = document.createElement('canvas');
      c.width = Math.round(canvas.width * sc);
      c.height = Math.round(canvas.height * sc);
      c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    })();

    let doc;
    if (S.scanTarget && S.scanTarget !== 'new' && (doc = S.docs.find((d) => d.id === S.scanTarget))) {
      updateDocText(doc, doc.text ? `${doc.text}\n\n${text}` : text);
    } else {
      doc = newDoc(text);
    }
    const pages = await Store.get(`img:${doc.id}`, []);
    pages.push(thumb);
    await Store.set(`img:${doc.id}`, pages);
    await openDoc(doc.id);
    toast('다 읽었어요! 잘못 읽힌 글자는 ✎ 텍스트 수정으로 고칠 수 있어요.', 4000);
  } catch (err) {
    busy(false);
    console.error(err);
    toast(err.message || '글자 인식 중 오류가 났어요.', 4000);
  } finally {
    ocrLogger = null;
  }
}

/* ===================== 손글씨 패드 (애플 펜슬) ===================== */
function openPad(blankId) {
  const input = document.querySelector(`.blank input[data-id="${blankId}"]`);
  const body = openModal(`
    <h3>✏️ 손글씨로 쓰기</h3>
    <p>애플 펜슬로 크게 또박또박 쓴 뒤 <b>인식해서 넣기</b>를 누르세요. 인식된 글자는 칸에 들어가며 고칠 수 있어요.</p>
    <canvas class="pad-canvas" id="padCv"></canvas>
    <div class="actions">
      <button class="btn" id="pClear">전부 지우기</button>
      <button class="btn" id="pUndo">↶ 한 획 취소</button>
      <div style="flex:1"></div>
      <button class="btn" id="pCancel">취소</button>
      <button class="btn primary" id="pOk">인식해서 넣기</button>
    </div>`);
  $('#modal').dataset.lock = '1';
  const cv = body.querySelector('#padCv');
  const dpr = window.devicePixelRatio || 1;
  const box = cv.getBoundingClientRect();
  cv.width = Math.round(box.width * dpr);
  cv.height = Math.round(box.height * dpr);
  const ctx = cv.getContext('2d');
  const strokes = [];
  let cur = null, penSeen = false;

  function redraw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#111';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      for (let i = 1; i < s.length; i++) {
        ctx.lineWidth = s[i].w;
        ctx.beginPath();
        ctx.moveTo(s[i - 1].x, s[i - 1].y);
        ctx.lineTo(s[i].x, s[i].y);
        ctx.stroke();
      }
    }
  }
  const pt = (e) => {
    const b = cv.getBoundingClientRect();
    const p = e.pointerType === 'pen' && e.pressure ? e.pressure : 0.5;
    return { x: (e.clientX - b.left) * dpr, y: (e.clientY - b.top) * dpr, w: (3 + p * 5) * dpr };
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') penSeen = true;
    if (penSeen && e.pointerType === 'touch') return; // 펜 사용 중엔 손바닥 터치 무시
    cv.setPointerCapture(e.pointerId);
    cur = [pt(e)];
    strokes.push(cur);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) cur.push(pt(ev));
    redraw();
  });
  const up = () => { cur = null; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);

  const close = () => { delete $('#modal').dataset.lock; closeModal(); };
  body.querySelector('#pClear').onclick = () => { strokes.length = 0; redraw(); };
  body.querySelector('#pUndo').onclick = () => { strokes.pop(); redraw(); };
  body.querySelector('#pCancel').onclick = close;
  body.querySelector('#pOk').onclick = async () => {
    const pts = strokes.flat();
    if (!pts.length) { close(); return; }
    // 쓴 부분만 잘라서 인식하기 좋은 크기로
    const pad = 12 * dpr;
    const x0 = Math.max(0, Math.min(...pts.map((p) => p.x)) - pad);
    const y0 = Math.max(0, Math.min(...pts.map((p) => p.y)) - pad);
    const x1 = Math.min(cv.width, Math.max(...pts.map((p) => p.x)) + pad);
    const y1 = Math.min(cv.height, Math.max(...pts.map((p) => p.y)) + pad);
    const sc = Math.min(1.5, 90 / (y1 - y0));
    const out = document.createElement('canvas');
    out.width = Math.round((x1 - x0) * sc) + 40;
    out.height = Math.round((y1 - y0) * sc) + 40;
    const o = out.getContext('2d');
    o.fillStyle = '#fff';
    o.fillRect(0, 0, out.width, out.height);
    o.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 20, 20, out.width - 40, out.height - 40);

    close();
    busy(true, '손글씨 읽는 중…', 0.3, '');
    try {
      const worker = await getWorker();
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      const { data } = await worker.recognize(out);
      let text = (data.text || '').replace(/[|_\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
      busy(false);
      if (!text) { toast('글씨를 읽지 못했어요. 조금 더 크게 써 주세요.'); return; }
      if (input && !input.readOnly) {
        input.value = text;
        S.qs.responses[blankId] = text;
        input.focus();
      }
      toast(`인식: "${text}" — 틀리면 칸에서 바로 고치세요`);
    } catch (err) {
      busy(false);
      toast(err.message || '손글씨 인식 중 오류가 났어요.');
    }
  };
}

/* ===================== 설정 / 백업 ===================== */
function openSettings() {
  const st = S.settings;
  const body = openModal(`
    <h3>⚙️ 설정</h3>
    <div class="setting">
      <div><b>뜻 중 하나만 맞아도 정답</b><div class="d">예) 정답이 "사과/능금"일 때 "사과"만 써도 정답, 괄호 속 내용은 생략 가능</div></div>
      <input type="checkbox" id="stLenient" ${st.lenient ? 'checked' : ''} />
    </div>
    <div class="setting">
      <div><b>이어서 지운 단어는 한 칸으로</b><div class="d">예) "give up"을 두 단어 모두 지우면 빈칸 하나로 만들어요 (같은 언어끼리만)</div></div>
      <input type="checkbox" id="stMerge" ${st.merge ? 'checked' : ''} />
    </div>
    <div class="setting">
      <div><b>외운 단어로 옮기는 기준</b><div class="d">오답노트 문제를 연속 몇 번 맞히면 '외운 단어'로 옮길까요?</div></div>
      <select id="stMaster">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${st.masterAfter === n ? 'selected' : ''}>${n}번</option>`).join('')}</select>
    </div>
    <div class="setting">
      <div><b>발음 속도</b><div class="d">🔊 버튼으로 듣는 영어 발음 속도</div></div>
      <select id="stRate">${[[0.6, '느리게'], [0.9, '보통'], [1.1, '빠르게']].map(([v, l]) => `<option value="${v}" ${st.speakRate === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="setting">
      <div><b>모든 데이터 지우기</b><div class="d">단어장, 기록, 오답노트를 모두 삭제해요 (되돌릴 수 없어요)</div></div>
      <button class="btn small danger" id="stWipe">전체 삭제</button>
    </div>
    <div class="actions"><button class="btn primary" id="stClose">닫기</button></div>`);
  body.querySelector('#stClose').onclick = () => {
    st.lenient = body.querySelector('#stLenient').checked;
    st.merge = body.querySelector('#stMerge').checked;
    st.masterAfter = +body.querySelector('#stMaster').value;
    st.speakRate = +body.querySelector('#stRate').value;
    saveSettings();
    closeModal();
    render();
  };
  body.querySelector('#stWipe').onclick = async () => {
    if (!(await ask('정말 모든 데이터를 삭제할까요? 되돌릴 수 없어요.', '모두 삭제', true))) return;
    for (const d of S.docs) await Store.del(`img:${d.id}`);
    S.docs = []; S.attempts = []; S.wrong = [];
    await Promise.all([saveDocs(), saveAttempts(), saveWrong()]);
    go('home', true);
    toast('모든 데이터를 삭제했어요');
  };
}

function openBackup() {
  const body = openModal(`
    <h3>💾 백업 / 복원</h3>
    <p>단어장·학습 기록·오답노트를 파일로 저장하거나 다른 기기로 옮길 수 있어요. (원본 사진은 포함되지 않아요)<br/>
    Safari에서 오래 사용하지 않으면 데이터가 지워질 수 있으니, <b>홈 화면에 추가</b>해서 쓰고 가끔 백업해 두세요.</p>
    <div class="actions" style="justify-content:flex-start">
      <button class="btn primary" id="bkOut">⬆️ 백업 파일 만들기</button>
      <button class="btn" id="bkIn">⬇️ 백업 파일 불러오기</button>
      <div style="flex:1"></div>
      <button class="btn" id="bkClose">닫기</button>
    </div>`);
  body.querySelector('#bkClose').onclick = closeModal;
  body.querySelector('#bkOut').onclick = async () => {
    const data = JSON.stringify({ app: 'word-scan-study', version: 1, date: Date.now(), docs: S.docs, attempts: S.attempts, wrong: S.wrong, settings: S.settings });
    const name = `단어학습-백업-${fmtDate(Date.now()).slice(0, 10).replace(/\./g, '')}.json`;
    const file = new File([data], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  body.querySelector('#bkIn').onclick = () => { const i = $('#fileBackup'); i.value = ''; i.click(); };
}

$('#fileBackup').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'word-scan-study') throw new Error();
    if (!(await ask('백업을 불러올까요? 같은 항목은 백업 내용으로 바뀌고, 나머지는 합쳐져요.', '불러오기'))) return;
    const merge = (cur, inc, key) => {
      const map = new Map(cur.map((x) => [x[key], x]));
      for (const x of inc || []) map.set(x[key], x);
      return [...map.values()];
    };
    S.docs = merge(S.docs, data.docs, 'id').sort((a, b) => b.updated - a.updated);
    S.attempts = merge(S.attempts, data.attempts, 'id').sort((a, b) => b.date - a.date);
    S.wrong = merge(S.wrong, data.wrong, 'key');
    S.settings = { ...DEFAULT_SETTINGS, ...S.settings, ...(data.settings || {}) };
    await Promise.all([saveDocs(), saveAttempts(), saveWrong(), saveSettings()]);
    go('home', true);
    toast('백업을 불러왔어요 ✅');
  } catch (err) {
    toast('백업 파일을 읽을 수 없어요.');
  }
});

/* ===================== 시작 ===================== */
(async function init() {
  S.docs = await Store.get('docs', []);
  S.attempts = await Store.get('attempts', []);
  S.wrong = await Store.get('wrong', []);
  S.settings = { ...DEFAULT_SETTINGS, ...(await Store.get('settings', {})) };
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* 무시 */ }
  // 인터넷 주소(https)로 열었을 때 오프라인에서도 쓸 수 있게
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  render();
})();
