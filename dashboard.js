/* dashboard.js — 통합 대시보드 (업무 요청 관리 · 통계 · AI 성능 분석)
 *
 * 데이터는 두 갈래로 따로 보관한다 (서로 합산하지 않음).
 *   1) 업무 요청 기록  localStorage 'meditask.dashboard.tasks.v1'  — 사용자가 '업무 저장'을 누른 요청만
 *   2) AI 평가 기록    localStorage 'meditask.dashboard.evals.v1'  — 정답이 있는 평가 문장의 채점 결과(가져오기)
 * 저장 위치는 이 브라우저뿐이다. 서버로 보내지 않고, 개인정보를 가린 문장만 저장한다.
 * 업무 유형·긴급도 이름은 criteria.json(window.MediApp.criteria())에서 읽는다. */
(function () {
  'use strict';

  const KEY_TASKS = 'meditask.dashboard.tasks.v1';
  const KEY_EVALS = 'meditask.dashboard.evals.v1';
  const STATUSES = ['접수', '결정대기', '진행중', '보류', '완료'];
  const DONE = '완료';
  const PENDING = '결정대기';
  // 차트 색 (dataviz 검증 통과: 상태 5색·완료 비교 2색·긴급도 3색, 흰 배경 기준). 색만으로 구분하지 않도록 항상 글자 라벨을 같이 둔다.
  const STATUS_COLOR = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  const URG_COLOR = ['#ba1a1a', '#c77700', '#00897b'];
  const OPEN_COLOR = '#2a78d6';
  const DONE_COLOR = '#e87ba4';
  const BAR_COLOR = '#2a78d6';
  const TREND = [{ key: 'cat', label: '업무 유형', color: '#2a78d6' }, { key: 'urg', label: '긴급도', color: '#eb6834' }, { key: 'both', label: '완전 일치', color: '#1baf7a' }];
  const URG_CLASS = ['u-high', 'u-mid', 'u-low'];
  const MAX_FILE = 2 * 1024 * 1024;
  const MAX_TEXT = 500;
  const MAX_REASON = 1000;
  const MAX_ASSIGNEE = 30;
  const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-]{1,63}$/;
  const ID_RE = /^[A-Za-z0-9_#\-]{1,40}$/;

  const $ = (id) => document.getElementById(id);

  // ======================= 작은 도구 =======================
  function h(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k === 'style') n.style.cssText = v;
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    for (let i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }
  function append(n) {
    for (let i = 1; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) { c.forEach((x) => append(n, x)); continue; }
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach((k) => { if (attrs[k] != null) n.setAttribute(k, attrs[k]); });
    for (let i = 2; i < arguments.length; i++) if (arguments[i]) n.appendChild(arguments[i]);
    return n;
  }
  const icon = (name, cls) => h('span', { class: 'icon ' + (cls || 'icon-16'), 'aria-hidden': 'true', text: name });
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const pad = (n) => String(n).padStart(2, '0');
  const isISO = (v) => typeof v === 'string' && v.length <= 40 && !isNaN(Date.parse(v));
  function dayOf(iso) { const d = new Date(iso); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDT(iso) { if (!isISO(iso)) return '—'; const d = new Date(iso); return dayOf(iso) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  const pct = (n, t) => (t ? (Math.round((n / t) * 1000) / 10).toFixed(1) : '0.0') + '%';
  const sec = (ms) => (typeof ms === 'number' && isFinite(ms) ? (ms / 1000).toFixed(2) + '초' : '기록 없음');
  function hash(str) { let x = 0x811c9dc5; for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x.toString(16).padStart(8, '0'); }
  function stamp() { const d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mask = (t) => (window.MediMask ? window.MediMask.maskText(String(t)).masked : String(t));

  // ======================= 상태 =======================
  const S = {
    ready: false,
    cats: [], levels: [], top: '', criteriaVersion: null,
    tasks: [], evals: emptyEvals(),
    taskErr: null, evalErr: null,
    f: blankFilter(),
    advOpen: false,
    view: null,            // 사용자가 고른 보기 (없으면 화면 폭으로 결정)
    selRun: '',            // AI 지표에 보여 줄 회차
    misRun: 'all',         // 오분류 분석 대상
    lastRead: null,
    openId: null
  };
  function blankFilter() { return { quick: '', q: '', assignee: '', category: '', urgency: '', status: '', from: '', to: '', sort: 'new' }; }
  function emptyEvals() { return { schema: 'meditask.evals', version: 1, imports: [], runs: [], baselines: [] }; }

  // ======================= 저장소 =======================
  function readKey(k) {
    try {
      const raw = localStorage.getItem(k);
      if (raw == null) return { data: null };
      return { data: JSON.parse(raw) };
    } catch (e) {
      return { err: e && e.name === 'SyntaxError' ? '저장된 기록의 형식이 손상되어 읽지 못했습니다.' : '이 브라우저에서 저장소를 사용할 수 없습니다 (사생활 보호 모드 등).' };
    }
  }
  function writeKey(k, obj) {
    try { localStorage.setItem(k, JSON.stringify(obj)); return true; }
    catch (e) { toast('저장하지 못했습니다. 브라우저 저장소가 가득 찼거나 사용할 수 없습니다.', 'error'); return false; }
  }
  function loadAll() {
    S.taskErr = null; S.evalErr = null;
    const t = readKey(KEY_TASKS);
    if (t.err) { S.taskErr = t.err; S.tasks = []; }
    else if (t.data == null) S.tasks = [];
    else {
      const v = parseTaskFile(t.data);
      if (v.error) { S.taskErr = '저장된 업무 기록이 올바르지 않아 표시하지 않았습니다: ' + v.error; S.tasks = []; }
      else S.tasks = v.tasks;
    }
    const e = readKey(KEY_EVALS);
    if (e.err) { S.evalErr = e.err; S.evals = emptyEvals(); }
    else if (e.data == null) S.evals = emptyEvals();
    else {
      const v = parseEvalStore(e.data);
      if (v.error) { S.evalErr = '저장된 평가 기록이 올바르지 않아 표시하지 않았습니다: ' + v.error; S.evals = emptyEvals(); }
      else S.evals = v.store;
    }
    S.lastRead = new Date();
  }
  function saveTasks() {
    if (S.taskErr) { toast('저장된 업무 기록에 문제가 있어 저장을 멈췄습니다. 아래 데이터 관리에서 정리하세요.', 'error'); return false; }
    return writeKey(KEY_TASKS, { schema: 'meditask.tasks', version: 1, tasks: S.tasks });
  }
  function saveEvals() {
    if (S.evalErr) { toast('저장된 평가 기록에 문제가 있어 저장을 멈췄습니다. 아래 데이터 관리에서 정리하세요.', 'error'); return false; }
    return writeKey(KEY_EVALS, S.evals);
  }

  // ======================= 업무 기록: 구조 검증 =======================
  const str = (v, max) => typeof v === 'string' && v.length <= max;
  function normTask(t) {
    if (!t || typeof t !== 'object') return { error: '항목이 객체가 아님' };
    const c = t.classification;
    if (!str(t.id, 40) || !ID_RE.test(t.id)) return { error: '업무 ID 형식 오류' };
    const at = ' (' + t.id + ')';
    if (!isISO(t.created_at) || !isISO(t.updated_at)) return { error: '등록·수정 일시 형식 오류' + at };
    if (!str(t.text_masked, MAX_TEXT) || !t.text_masked.trim()) return { error: '요청 내용 누락 또는 500자 초과' + at };
    if (!c || typeof c !== 'object') return { error: '분류 결과 누락' + at };
    if (!S.cats.includes(c.category)) return { error: '알 수 없는 업무 유형 "' + String(c.category).slice(0, 20) + '"' + at };
    if (!S.levels.includes(c.urgency)) return { error: '알 수 없는 긴급도' + at };
    if (!str(c.reason, MAX_REASON)) return { error: '분류 근거 형식 오류' + at };
    if (c.method !== 'gemini' && c.method !== 'rule') return { error: '분류 방식은 gemini 또는 rule' + at };
    if (c.model != null && !(typeof c.model === 'string' && MODEL_ID_RE.test(c.model))) return { error: '모델 ID 형식 오류' + at };
    const o = t.override;
    if (o != null) {
      if (typeof o !== 'object') return { error: '관리자 수정값 형식 오류' + at };
      if (o.category != null && !S.cats.includes(o.category)) return { error: '관리자 수정 업무 유형 오류' + at };
      if (o.urgency != null && !S.levels.includes(o.urgency)) return { error: '관리자 수정 긴급도 오류' + at };
    }
    if (t.assignee != null && !str(t.assignee, MAX_ASSIGNEE)) return { error: '담당자는 30자 이하' + at };
    if (!STATUSES.includes(t.status)) return { error: '알 수 없는 진행 상태' + at };
    if (typeof t.needs_check !== 'boolean') return { error: '추가확인 필요 값은 true/false' + at };
    if (t.status === DONE && !isISO(t.completed_at)) return { error: '완료 업무에 완료 일시 없음' + at };
    if (t.status !== DONE && t.completed_at != null) return { error: '완료되지 않은 업무에 완료 일시가 있음' + at };
    // 화이트리스트 필드만 남긴다 (알 수 없는 필드·원문은 저장하지 않음). 요청 문장은 한 번 더 가린다.
    const ov = o && (o.category || o.urgency) ? { category: o.category || null, urgency: o.urgency || null, updated_at: isISO(o.updated_at) ? o.updated_at : t.updated_at } : null;
    return { task: {
      id: t.id, created_at: t.created_at, text_masked: mask(t.text_masked),
      classification: {
        category: c.category, urgency: c.urgency, reason: c.reason, method: c.method, fallback: !!c.fallback,
        model: c.model || null, criteria_version: c.criteria_version == null ? null : String(c.criteria_version).slice(0, 20),
        urgency_step: Number.isInteger(c.urgency_step) ? c.urgency_step : null
      },
      override: ov,
      assignee: (t.assignee || '').trim(),
      status: t.status, prev_status: STATUSES.includes(t.prev_status) && t.prev_status !== DONE ? t.prev_status : null,
      needs_check: t.needs_check,
      completed_at: t.status === DONE ? t.completed_at : null,
      updated_at: t.updated_at
    } };
  }
  function parseTaskFile(d) {
    if (!d || typeof d !== 'object' || d.schema !== 'meditask.tasks' || !Array.isArray(d.tasks)) return { error: 'MEDI TASK 업무 기록 형식(schema: meditask.tasks)이 아닙니다' };
    if (d.tasks.length > 5000) return { error: '업무가 5,000건을 넘습니다' };
    const out = [];
    const ids = new Set();
    for (let i = 0; i < d.tasks.length; i++) {
      const r = normTask(d.tasks[i]);
      if (r.error) return { error: (i + 1) + '번째 업무: ' + r.error };
      if (ids.has(r.task.id)) return { error: '같은 업무 ID가 두 번 있습니다 (' + r.task.id + ')' };
      ids.add(r.task.id);
      out.push(r.task);
    }
    return { tasks: out };
  }

  // ======================= 평가 기록: 구조·계산 검증 =======================
  function summarize(items) {
    const total = items.length;
    const cat = items.filter((i) => i.category_correct).length;
    const urg = items.filter((i) => i.urgency_correct).length;
    const both = items.filter((i) => i.category_correct && i.urgency_correct).length;
    return { total: total, category_correct: cat, urgency_correct: urg, exact_match: both, misclassified: total - both, failed: items.filter((i) => i.failed).length };
  }
  const SUM_KEYS = ['total', 'category_correct', 'urgency_correct', 'exact_match', 'misclassified', 'failed'];

  /** 채점 항목 목록 검증: 값 범위 + 항목별 정답 여부가 실제 비교 결과와 같은지 */
  function checkItems(items, label) {
    if (!Array.isArray(items) || !items.length) return { error: label + ': 채점 항목(items)이 없습니다' };
    if (items.length > 1000) return { error: label + ': 채점 항목이 너무 많습니다' };
    const out = [];
    const ids = new Set();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const at = label + ' ' + (i + 1) + '번째 문장';
      if (!it || typeof it !== 'object') return { error: at + ': 형식 오류' };
      if (!str(it.id, 40) || !ID_RE.test(it.id)) return { error: at + ': 문장 ID 형식 오류' };
      if (ids.has(it.id)) return { error: at + ': 문장 ID 중복 (' + it.id + ')' };
      ids.add(it.id);
      if (!S.cats.includes(it.gold_category) || !S.levels.includes(it.gold_urgency)) return { error: at + ' (' + it.id + '): 정답 업무 유형·긴급도가 분류 기준에 없음', kind: 'range' };
      if (typeof it.failed !== 'boolean') return { error: at + ' (' + it.id + '): failed 값 누락' };
      if (it.failed) {
        if (it.pred_category != null || it.pred_urgency != null) return { error: at + ' (' + it.id + '): 응답 실패인데 예측값이 있음', kind: 'calc' };
      } else if (!S.cats.includes(it.pred_category) || !S.levels.includes(it.pred_urgency)) return { error: at + ' (' + it.id + '): 예측 업무 유형·긴급도가 분류 기준에 없음', kind: 'range' };
      const cOk = !it.failed && it.pred_category === it.gold_category;
      const uOk = !it.failed && it.pred_urgency === it.gold_urgency;
      if (it.category_correct !== cOk || it.urgency_correct !== uOk || (it.exact_match != null && it.exact_match !== (cOk && uOk))) {
        return { error: at + ' (' + it.id + '): 정답 여부 표시가 실제 비교 결과와 다릅니다', kind: 'calc' };
      }
      out.push({ id: it.id, gold_category: it.gold_category, gold_urgency: it.gold_urgency, pred_category: it.failed ? null : it.pred_category, pred_urgency: it.failed ? null : it.pred_urgency, category_correct: cOk, urgency_correct: uOk, exact_match: cOk && uOk, failed: it.failed });
    }
    return { items: out };
  }
  function checkSummary(summary, items, label) {
    const re = summarize(items);
    if (!summary || typeof summary !== 'object') return { error: label + ': 요약(summary) 누락' };
    for (const k of SUM_KEYS) {
      if (summary[k] !== re[k]) return { error: label + ': 요약 수치 ' + k + '=' + summary[k] + ' 이(가) 항목에서 다시 계산한 값 ' + re[k] + '과 다릅니다', kind: 'calc' };
    }
    return { summary: re };
  }
  function normRun(r, modelId, displayName, stage, count, label) {
    if (!r || typeof r !== 'object') return { error: label + ': 형식 오류' };
    if (!Number.isInteger(r.run) || r.run < 1 || r.run > 99) return { error: label + ': 회차(run) 번호 오류' };
    if (!isISO(r.started_at)) return { error: label + ': 평가 시작 일시(started_at) 누락' };
    const it = checkItems(r.items, label);
    if (it.error) return it;
    if (count != null && it.items.length !== count) return { error: label + ': 문장 수 ' + it.items.length + '개가 데이터셋 문장 수 ' + count + '개와 다릅니다', kind: 'calc' };
    const sm = checkSummary(r.summary, it.items, label);
    if (sm.error) return sm;
    const ms = typeof r.avg_response_ms === 'number' && isFinite(r.avg_response_ms) && r.avg_response_ms >= 0 ? Math.round(r.avg_response_ms) : null;
    const sig = hash(it.items.map((x) => x.id + ':' + x.pred_category + ':' + x.pred_urgency).join('|'));
    return { run: {
      key: modelId + '|' + r.run + '|' + r.started_at + '|' + sig,
      model_id: modelId, display_name: str(displayName, 80) ? displayName : null, stage: stage === 'preview' ? 'preview' : null,
      run: r.run, started_at: r.started_at, finished_at: isISO(r.finished_at) ? r.finished_at : null,
      avg_response_ms: ms, summary: sm.summary, items: it.items
    } };
  }
  function normBaseline(b, count) {
    if (b == null) return { baseline: null };
    const it = checkItems(b.items, '규칙 기반');
    if (it.error) return it;
    if (count != null && it.items.length !== count) return { error: '규칙 기반: 문장 수가 데이터셋 문장 수와 다릅니다', kind: 'calc' };
    const sm = checkSummary(b.summary, it.items, '규칙 기반');
    if (sm.error) return sm;
    return { baseline: { key: 'rule|' + hash(it.items.map((x) => x.id + ':' + x.pred_category + ':' + x.pred_urgency).join('|')), summary: sm.summary, items: it.items } };
  }

  /** 성능 평가 탭이 내려 주는 ai_채점결과.json (또는 같은 구조) 해석 */
  function parseAIReport(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'JSON 최상위가 객체가 아닙니다', kind: 'required' };
    if (!d.dataset || !Number.isInteger(d.dataset.count) || d.dataset.count < 1) return { error: 'dataset.count(평가 문장 수)가 없습니다', kind: 'required' };
    if (!isISO(d.generated_at)) return { error: 'generated_at(생성 일시)이 없습니다', kind: 'required' };
    const count = d.dataset.count;
    const groups = [];
    if (Array.isArray(d.models) && d.models.length) {
      d.models.forEach((m) => groups.push({ model: m && m.model_id, name: m && m.display_name, stage: m && m.stage, runs: m && m.runs }));
    } else if (Array.isArray(d.gemini_runs) && d.gemini_runs.length) {
      const id = d.evaluated_model || d.model || (d.gemini_runs[0] && d.gemini_runs[0].model);
      groups.push({ model: id, name: null, stage: null, runs: d.gemini_runs });
    } else return { error: 'AI 채점 결과(models 또는 gemini_runs)가 없습니다', kind: 'required' };
    const runs = [];
    for (const g of groups) {
      if (typeof g.model !== 'string' || !MODEL_ID_RE.test(g.model)) return { error: '모델 ID가 없거나 형식이 잘못되었습니다', kind: 'required' };
      if (!Array.isArray(g.runs) || !g.runs.length) return { error: g.model + ': 회차(runs)가 없습니다', kind: 'required' };
      for (const r of g.runs) {
        const n = normRun(r, g.model, g.name, g.stage, count, g.model + ' ' + (r && r.run) + '차');
        if (n.error) return n;
        if (runs.some((x) => x.model_id === n.run.model_id && x.run === n.run.run)) return { error: g.model + ' ' + n.run.run + '차가 파일 안에 두 번 있습니다', kind: 'required' };
        runs.push(n.run);
      }
    }
    const b = normBaseline(d.rule_based, count);
    if (b.error) return b;
    return { meta: { generated_at: d.generated_at, criteria_version: d.criteria_version == null ? null : String(d.criteria_version).slice(0, 20), dataset_count: count }, runs: runs, baseline: b.baseline };
  }

  /** 대시보드가 내보낸 평가 기록(schema: meditask.evals) 해석 — 저장소 읽기에도 쓴다 */
  function parseEvalStore(d) {
    if (!d || typeof d !== 'object' || d.schema !== 'meditask.evals' || !Array.isArray(d.imports) || !Array.isArray(d.runs) || !Array.isArray(d.baselines)) return { error: 'MEDI TASK 평가 기록 형식(schema: meditask.evals)이 아닙니다', kind: 'required' };
    const store = emptyEvals();
    const importIds = new Set();
    for (const im of d.imports) {
      if (!im || !str(im.import_id, 40) || !isISO(im.imported_at) || !Number.isInteger(im.dataset_count)) return { error: '가져오기 기록 형식 오류', kind: 'required' };
      if (importIds.has(im.import_id)) return { error: '가져오기 ID 중복', kind: 'required' };
      importIds.add(im.import_id);
      store.imports.push({ import_id: im.import_id, source: str(im.source, 120) ? im.source : '알 수 없음', imported_at: im.imported_at, generated_at: isISO(im.generated_at) ? im.generated_at : null, criteria_version: im.criteria_version == null ? null : String(im.criteria_version).slice(0, 20), dataset_count: im.dataset_count });
    }
    const keys = new Set();
    for (const r of d.runs) {
      if (!r || !importIds.has(r.import_id) || typeof r.model_id !== 'string' || !MODEL_ID_RE.test(r.model_id)) return { error: '평가 회차의 모델·가져오기 정보 오류', kind: 'required' };
      const im = store.imports.find((x) => x.import_id === r.import_id);
      const n = normRun(r, r.model_id, r.display_name, r.stage, im.dataset_count, r.model_id + ' ' + r.run + '차');
      if (n.error) return n;
      if (keys.has(n.run.key)) continue;
      keys.add(n.run.key);
      n.run.import_id = r.import_id;
      store.runs.push(n.run);
    }
    for (const b of d.baselines) {
      if (!b || !importIds.has(b.import_id)) return { error: '규칙 기준선의 가져오기 정보 오류', kind: 'required' };
      const n = normBaseline(b, null);
      if (n.error) return n;
      if (store.baselines.some((x) => x.key === n.baseline.key)) continue;
      n.baseline.import_id = b.import_id;
      store.baselines.push(n.baseline);
    }
    return { store: store };
  }

  // ======================= 업무 계산 =======================
  const effCat = (t) => (t.override && t.override.category) || t.classification.category;
  const effUrg = (t) => (t.override && t.override.urgency) || t.classification.urgency;
  const isOpen = (t) => t.status !== DONE;
  function quickDefs() {
    return [
      { key: 'open', title: '미해결', sub: '완료 제외', icon: 'pending_actions', tone: 'q-open', rule: '진행 상태가 완료가 아닌 모든 업무', test: isOpen },
      { key: 'pending', title: '결정대기', sub: "진행 상태 '결정대기'", icon: 'hourglass_top', tone: 'q-pending', rule: "진행 상태가 '결정대기'인 업무", test: (t) => t.status === PENDING },
      { key: 'high', title: '긴급 ' + S.top + ' · 미해결', sub: '완료 제외', icon: 'priority_high', tone: 'q-high', rule: "긴급도가 '" + S.top + "'이고 완료되지 않은 업무 (관리자 수정값 우선)", test: (t) => effUrg(t) === S.top && isOpen(t) },
      { key: 'check', title: '추가확인 필요', sub: '확인 필요 표시', icon: 'flag', tone: 'q-check', rule: "'추가확인 필요'를 켠 업무", test: (t) => t.needs_check }
    ];
  }
  function filtered() {
    const f = S.f;
    const q = f.q.trim().toLowerCase();
    const a = f.assignee.trim().toLowerCase();
    const quick = f.quick ? quickDefs().find((x) => x.key === f.quick) : null;
    const list = S.tasks.filter((t) => {
      if (quick && !quick.test(t)) return false;
      if (q && t.text_masked.toLowerCase().indexOf(q) < 0 && t.id.toLowerCase().indexOf(q) < 0) return false;
      if (a && (t.assignee || '').toLowerCase().indexOf(a) < 0) return false;
      if (f.category && effCat(t) !== f.category) return false;
      if (f.urgency && effUrg(t) !== f.urgency) return false;
      if (f.status && t.status !== f.status) return false;
      const d = dayOf(t.created_at);
      if (f.from && d < f.from) return false;
      if (f.to && d > f.to) return false;
      return true;
    });
    const by = {
      new: (x, y) => y.created_at.localeCompare(x.created_at),
      old: (x, y) => x.created_at.localeCompare(y.created_at),
      urgency: (x, y) => S.levels.indexOf(effUrg(x)) - S.levels.indexOf(effUrg(y)) || y.created_at.localeCompare(x.created_at),
      updated: (x, y) => y.updated_at.localeCompare(x.updated_at)
    };
    return list.sort(by[f.sort] || by.new);
  }

  // ======================= 알림 · 말풍선 =======================
  let toastTimer = null;
  function toast(msg, tone) {
    const t = $('db-toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'db-toast is-show' + (tone === 'error' ? ' is-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'db-toast'; }, 3600);
  }
  function showTip(target, x, y) {
    const tip = $('db-tip');
    if (!tip) return;
    tip.textContent = target.getAttribute('data-tip');
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const px = x != null ? x : r.left + r.width / 2;
    const py = y != null ? y : r.top;
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, px - w / 2)) + 'px';
    tip.style.top = Math.max(8, py - hh - 10) + 'px';
  }
  function hideTip() { const tip = $('db-tip'); if (tip) tip.hidden = true; }

  // ======================= 화면 뼈대 =======================
  function build() {
    const root = clear($('db-root'));
    append(root, [
      h('div', { id: 'db-alerts', class: 'stack-8' }),
      h('nav', { class: 'db-subnav', 'aria-label': '대시보드 영역 이동' },
        [['db-sec-tasks', 'task', '업무 관리'], ['db-sec-stats', 'bar_chart', '통계 분석'], ['db-sec-ai', 'model_training', 'AI 성능'], ['db-sec-data', 'database', '데이터 관리']].map((x) =>
          h('button', { type: 'button', class: 'db-subnav-btn', 'data-target': x[0], onclick: () => scrollToId(x[0]) }, icon(x[1]), h('span', { text: x[2] })))),

      // ---------- 업무 요청 관리 ----------
      h('section', { id: 'db-sec-tasks', class: 'db-section', 'aria-labelledby': 'db-h-tasks' },
        h('div', { class: 'db-sec-head' },
          h('h2', { class: 'headline-md', id: 'db-h-tasks', text: '업무 요청 관리' }),
          h('span', { class: 'pill pill-soft db-source', id: 'db-task-source' })),
        h('div', { class: 'db-summary', id: 'db-summary' }),
        h('p', { class: 'label-xs muted db-summary-note', text: '카드는 서로 겹쳐 셀 수 있습니다 (예: 결정대기이면서 긴급 ' + S.top + '인 업무는 두 카드에 모두 포함). 카드를 누르면 아래 목록에 그 조건이 적용됩니다.' }),
        h('div', { class: 'card db-tools' },
          h('div', { class: 'db-tools-row' },
            h('label', { class: 'db-field db-search' }, h('span', { class: 'label-xs muted', text: '문장 검색' }),
              h('span', { class: 'db-input-wrap' }, icon('search'), h('input', { class: 'db-input', id: 'db-q', type: 'search', maxlength: '100', placeholder: '요청 내용·업무 ID', autocomplete: 'off' }))),
            h('label', { class: 'db-field db-assignee' }, h('span', { class: 'label-xs muted', text: '담당자 검색' }),
              h('span', { class: 'db-input-wrap' }, icon('person_search'), h('input', { class: 'db-input', id: 'db-assignee-q', type: 'search', maxlength: '30', placeholder: '담당자', autocomplete: 'off' }))),
            h('div', { class: 'db-tool-btns' },
              h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-adv-btn', 'aria-expanded': 'false', 'aria-controls': 'db-adv' }, icon('tune'), h('span', { text: '상세검색' })),
              h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-reset-btn' }, icon('filter_alt_off'), h('span', { text: '조건 초기화' })),
              h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-refresh-btn' }, icon('refresh'), h('span', { text: '업데이트' })),
              h('div', { class: 'seg db-viewseg', role: 'radiogroup', 'aria-label': '목록 보기 방식' },
                h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'data-mode': 'card', 'aria-checked': 'false' }, icon('grid_view'), '카드형'),
                h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'data-mode': 'table', 'aria-checked': 'false' }, icon('table_rows'), '표형')))),
          h('div', { class: 'db-adv', id: 'db-adv', hidden: true },
            selectField('db-f-category', '카테고리', [['', '전체']].concat(S.cats.map((c) => [c, c]))),
            selectField('db-f-urgency', '긴급도', [['', '전체']].concat(S.levels.map((c) => [c, c]))),
            selectField('db-f-status', '진행 상태', [['', '전체']].concat(STATUSES.map((c) => [c, c]))),
            h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '등록 시작일' }), h('input', { class: 'db-input db-date', id: 'db-f-from', type: 'date' })),
            h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '등록 종료일' }), h('input', { class: 'db-input db-date', id: 'db-f-to', type: 'date' })),
            selectField('db-f-sort', '정렬', [['new', '최근 등록순'], ['old', '오래된 등록순'], ['urgency', '긴급도 높은 순'], ['updated', '최근 수정순']])),
          h('p', { class: 'label-xs muted db-refresh-note', id: 'db-refresh-note', role: 'status' })),
        h('div', { class: 'db-active', id: 'db-active' }),
        h('div', { id: 'db-list', class: 'db-list' })),

      // ---------- 카테고리별 업무 통계 ----------
      h('section', { id: 'db-sec-stats', class: 'db-section', 'aria-labelledby': 'db-h-stats' },
        h('div', { class: 'db-sec-head' },
          h('h2', { class: 'headline-md', id: 'db-h-stats', text: '카테고리별 업무 통계' }),
          h('span', { class: 'pill pill-soft db-source', id: 'db-stats-source' })),
        h('p', { class: 'label-xs muted', text: '저장한 업무 기록 전체로 계산합니다 (위 목록의 검색 조건과 무관). AI 평가 문장은 포함하지 않습니다. 업무 유형·긴급도는 관리자 수정값이 있으면 그 값을 씁니다. 차트를 누르면 업무 목록에 해당 조건이 적용됩니다.' }),
        h('div', { id: 'db-stats' })),

      // ---------- AI 성능 ----------
      h('section', { id: 'db-sec-ai', class: 'db-section', 'aria-labelledby': 'db-h-ai' },
        h('div', { class: 'db-sec-head' },
          h('h2', { class: 'headline-md', id: 'db-h-ai', text: 'AI 성능 평가 및 오분류 분석' }),
          h('span', { class: 'pill pill-soft db-source', id: 'db-ai-source' })),
        h('p', { class: 'label-xs muted', text: '정답이 있는 평가 문장(answer.json)의 채점 결과만 사용합니다. 저장한 업무 기록은 정답이 없으므로 정확도 계산에서 제외합니다. 평가 결과는 아래에서 가져온 것만 표시하며, 미리 넣어 둔 숫자는 없습니다.' }),
        h('div', { class: 'card db-import-card' },
          h('div', { class: 'between db-import-head' },
            h('div', { class: 'row gap-6' }, icon('upload_file', 'icon-18 text-primary'), h('span', { class: 'title-sm', text: '평가 결과 가져오기' }))),
          h('div', { class: 'db-import-btns' },
            h('button', { type: 'button', class: 'btn btn-small btn-primary', id: 'db-eval-file-btn' }, icon('upload'), h('span', { text: 'JSON 파일 가져오기' })),
            h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-eval-session-btn', disabled: true }, icon('sync_alt'), h('span', { text: '현재 성능 평가 탭 결과 가져오기' })),
            h('input', { type: 'file', id: 'db-eval-file', accept: '.json,application/json', hidden: true })),
          h('p', { class: 'label-xs muted', text: '성능 평가 탭의 "AI 채점 결과 내려받기"로 받은 ai_채점결과.json 또는 이 대시보드에서 내보낸 평가 JSON을 가져옵니다. 파일 내용은 바꾸지 않고, 구조·값 범위·요약 수치 재계산을 확인한 뒤 같은 결과는 한 번만 저장합니다.' }),
          h('div', { id: 'db-import-result', class: 'db-import-result', hidden: true, role: 'status', 'aria-live': 'polite' })),
        h('div', { id: 'db-ai' })),

      // ---------- 데이터 관리 ----------
      h('section', { id: 'db-sec-data', class: 'db-section', 'aria-labelledby': 'db-h-data' },
        h('div', { class: 'db-sec-head' }, h('h2', { class: 'headline-md', id: 'db-h-data', text: '데이터 관리' })),
        h('div', { class: 'db-data-grid' },
          dataCard('tasks', 'task', '업무 요청 기록', '업무 저장으로 등록한 요청 (가린 문장)'),
          dataCard('evals', 'model_training', 'AI 성능 평가 기록', '가져온 평가 회차와 규칙 기준선')),
        h('p', { class: 'label-xs muted', text: '내려받는 파일에는 가린 요청 문장과 분류·관리 정보만 들어 있습니다. API 키·입력 원문은 저장하지도, 파일에 넣지도 않습니다. CSV는 Excel에서 한글이 깨지지 않도록 UTF-8(BOM)으로 저장합니다.' })),

      h('div', { id: 'db-tip', class: 'db-tip', role: 'tooltip', hidden: true }),
      h('div', { id: 'db-toast', class: 'db-toast', role: 'status', 'aria-live': 'polite' })
    ]);
    if (!$('db-dialog')) {
      const dlg = h('dialog', { id: 'db-dialog', class: 'db-dialog', 'aria-labelledby': 'db-dlg-title' });
      dlg.addEventListener('close', () => { S.openId = null; });
      // 바깥(어두운 영역)을 누르면 닫는다
      dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDetail(); });
      document.body.appendChild(dlg);
    }
    bindStatic();
  }

  function selectField(id, label, opts) {
    return h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: label }),
      h('select', { class: 'select', id: id }, opts.map((o) => h('option', { value: o[0], text: o[1] }))));
  }
  function dataCard(kind, ic, title, sub) {
    return h('div', { class: 'card db-data-card', id: 'db-data-' + kind },
      h('div', { class: 'between' },
        h('div', { class: 'row gap-6' }, icon(ic, 'icon-18 text-primary'), h('span', { class: 'title-sm', text: title })),
        h('span', { class: 'pill pill-soft', id: 'db-count-' + kind })),
      h('p', { class: 'label-xs muted', text: sub }),
      h('div', { class: 'db-data-btns' },
        h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-' + kind + '-csv' }, icon('download'), h('span', { text: 'CSV 내려받기' })),
        h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-' + kind + '-json' }, icon('data_object'), h('span', { text: 'JSON 내려받기' })),
        h('button', { type: 'button', class: 'btn btn-small btn-tonal', id: 'db-' + kind + '-import' }, icon('upload'), h('span', { text: 'JSON 가져오기' })),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', id: 'db-' + kind + '-delete' }, icon('delete'), h('span', { text: '전체 삭제' })),
        kind === 'tasks' ? h('input', { type: 'file', id: 'db-tasks-file', accept: '.json,application/json', hidden: true }) : null),
      h('div', { class: 'db-confirm-slot', id: 'db-confirm-' + kind }),
      kind === 'evals' ? h('div', { id: 'db-import-list', class: 'stack-6' }) : null);
  }

  function scrollToId(id) {
    const n = $(id);
    if (n) n.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }

  // ======================= 이벤트 연결 =======================
  function bindStatic() {
    $('db-q').addEventListener('input', (e) => { S.f.q = e.target.value; renderTasks(); });
    $('db-assignee-q').addEventListener('input', (e) => { S.f.assignee = e.target.value; renderTasks(); });
    const sel = { 'db-f-category': 'category', 'db-f-urgency': 'urgency', 'db-f-status': 'status', 'db-f-from': 'from', 'db-f-to': 'to', 'db-f-sort': 'sort' };
    Object.keys(sel).forEach((id) => $(id).addEventListener('change', (e) => { S.f[sel[id]] = e.target.value; renderTasks(); }));
    $('db-adv-btn').addEventListener('click', () => { S.advOpen = !S.advOpen; syncControls(); });
    $('db-reset-btn').addEventListener('click', () => { S.f = blankFilter(); syncControls(); renderTasks(); toast('검색·필터 조건을 모두 초기화했습니다.'); });
    $('db-refresh-btn').addEventListener('click', () => {
      loadAll(); renderAll();
      $('db-refresh-note').textContent = '이 브라우저 저장소에서 다시 읽었습니다 · ' + S.lastRead.toLocaleTimeString('ko-KR') + ' (서버 동기화 기능은 없습니다)';
    });
    document.querySelectorAll('.db-viewseg .seg-btn').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.mode; renderTasks(); }));

    $('db-eval-file-btn').addEventListener('click', () => $('db-eval-file').click());
    $('db-eval-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importEvalFile(f); });
    $('db-eval-session-btn').addEventListener('click', importEvalSession);
    $('db-evals-import').addEventListener('click', () => $('db-eval-file').click());
    $('db-tasks-import').addEventListener('click', () => $('db-tasks-file').click());
    $('db-tasks-file').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importTaskFile(f); });
    $('db-tasks-csv').addEventListener('click', downloadTasksCsv);
    $('db-tasks-json').addEventListener('click', downloadTasksJson);
    $('db-evals-csv').addEventListener('click', downloadEvalCsv);
    $('db-evals-json').addEventListener('click', downloadEvalJson);
    $('db-tasks-delete').addEventListener('click', () => confirmInline('db-confirm-tasks', '업무 요청 기록 ' + S.tasks.length + '건을 모두 삭제할까요? 삭제하면 되돌릴 수 없습니다. 필요하면 먼저 JSON으로 내려받으세요.', () => {
      try { localStorage.removeItem(KEY_TASKS); } catch (e) { /* 무시 */ }
      S.tasks = []; S.taskErr = null; renderAll(); refreshSaveButton(); toast('업무 요청 기록을 모두 삭제했습니다.');
    }));
    $('db-evals-delete').addEventListener('click', () => confirmInline('db-confirm-evals', '가져온 평가 기록(' + S.evals.runs.length + '개 회차)을 모두 삭제할까요? 원본 파일은 그대로이며 다시 가져올 수 있습니다.', () => {
      try { localStorage.removeItem(KEY_EVALS); } catch (e) { /* 무시 */ }
      S.evals = emptyEvals(); S.evalErr = null; S.selRun = ''; S.misRun = 'all'; renderAll(); toast('평가 기록을 모두 삭제했습니다.');
    }));

    // 차트 말풍선 (마우스·키보드 공통)
    const root = $('db-root');
    root.addEventListener('mousemove', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t, e.clientX, e.clientY); else hideTip(); });
    root.addEventListener('mouseleave', hideTip);
    root.addEventListener('focusin', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) showTip(t); else hideTip(); });
    root.addEventListener('focusout', hideTip);
    window.addEventListener('scroll', hideTip, { passive: true });
  }

  function confirmInline(slotId, msg, onYes) {
    const slot = clear($(slotId));
    const close = () => clear(slot);
    append(slot, h('div', { class: 'db-confirm', role: 'alertdialog', 'aria-label': '삭제 확인' },
      h('p', { class: 'body-sm', text: msg }),
      h('div', { class: 'db-confirm-btns' },
        h('button', { type: 'button', class: 'btn btn-small btn-tonal', onclick: close, text: '취소' }),
        h('button', { type: 'button', class: 'btn btn-small btn-danger-solid', onclick: () => { close(); onYes(); }, text: '삭제' }))));
    slot.querySelector('.btn-tonal').focus();
  }

  function syncControls() {
    const f = S.f;
    $('db-q').value = f.q; $('db-assignee-q').value = f.assignee;
    $('db-f-category').value = f.category; $('db-f-urgency').value = f.urgency; $('db-f-status').value = f.status;
    $('db-f-from').value = f.from; $('db-f-to').value = f.to; $('db-f-sort').value = f.sort;
    $('db-adv').hidden = !S.advOpen;
    $('db-adv-btn').setAttribute('aria-expanded', S.advOpen ? 'true' : 'false');
    $('db-adv-btn').classList.toggle('is-on', S.advOpen);
  }

  /** 차트·카드에서 목록 필터를 적용한다 (다른 조건은 유지) */
  function applyFilter(patch, scroll) {
    Object.assign(S.f, patch);
    // 상세검색 조건(카테고리·긴급도·상태·기간)이 바뀌면 상세검색 영역을 열어 무엇이 적용됐는지 보이게 한다
    if (patch.category !== undefined || patch.urgency !== undefined || patch.status !== undefined || patch.from !== undefined) S.advOpen = true;
    syncControls();
    renderTasks();
    if (scroll) scrollToId('db-active');
  }

  // ======================= 렌더링 =======================
  function renderAll() {
    if (!S.ready) return;
    renderAlerts();
    renderTasks();
    renderStats();
    renderAI();
    renderData();
  }

  function renderAlerts() {
    const box = clear($('db-alerts'));
    [[S.taskErr, 'tasks', '업무 요청 기록'], [S.evalErr, 'evals', 'AI 평가 기록']].forEach((x) => {
      if (!x[0]) return;
      append(box, h('div', { class: 'card card-error', role: 'alert' },
        h('div', { class: 'card-head' }, icon('error', 'text-error'), h('span', { class: 'title-sm', text: x[2] + '을 읽지 못했습니다' })),
        h('p', { class: 'body-sm', text: x[0] }),
        h('p', { class: 'label-xs muted', text: '기록을 지우지 않고 표시만 멈췄습니다. 데이터 관리의 "전체 삭제"로 정리하거나 올바른 JSON을 다시 가져오세요.' })));
    });
  }

  // ---------- 업무 관리 ----------
  function renderTasks() {
    const total = S.tasks.length;
    $('db-task-source').textContent = '출처: 이 브라우저에 저장한 업무 ' + total + '건';
    // 요약 카드
    const sum = clear($('db-summary'));
    quickDefs().forEach((q) => {
      const n = S.tasks.filter(q.test).length;
      const on = S.f.quick === q.key;
      append(sum, h('button', { type: 'button', class: 'db-qcard ' + q.tone + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', 'data-quick': q.key, title: '집계 기준: ' + q.rule,
        onclick: () => { S.f.quick = on ? '' : q.key; renderTasks(); } },
        h('span', { class: 'db-qcard-top' }, h('span', { class: 'db-qicon' }, icon(q.icon, 'icon-18')), icon(on ? 'close' : 'arrow_forward', 'icon-18 db-qarrow')),
        h('span', { class: 'db-qnum', text: String(n) }),
        h('span', { class: 'db-qtitle', text: q.title }),
        h('span', { class: 'db-qrule', text: q.rule })));
    });

    // 보기 방식
    const mode = S.view || (window.innerWidth < 768 ? 'card' : 'table');
    document.querySelectorAll('.db-viewseg .seg-btn').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    // 적용된 조건
    const list = filtered();
    const act = clear($('db-active'));
    const chips = activeChips();
    append(act, h('span', { class: 'label-md db-count', text: '업무 ' + list.length + '건' + (list.length !== total ? ' / 전체 ' + total + '건' : '') }));
    if (chips.length) {
      append(act, h('span', { class: 'label-xs muted', text: '적용된 조건:' }));
      chips.forEach((c) => append(act, h('button', { type: 'button', class: 'db-chip', 'aria-label': c.label + ' 조건 해제', onclick: c.clear }, h('span', { text: c.label }), icon('close', 'icon-14'))));
    } else append(act, h('span', { class: 'label-xs muted', text: '적용된 조건 없음' }));

    const box = clear($('db-list'));
    if (!total) {
      append(box, h('div', { class: 'card empty-card' },
        h('span', { class: 'empty-icon' }, icon('inbox')),
        h('span', { class: 'title-sm', text: '아직 저장한 업무가 없습니다' }),
        h('span', { class: 'label-xs muted', text: "업무 분류 탭에서 요청을 분류한 뒤 '업무 저장'을 누르면 여기에 표시됩니다." }),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: () => window.MediApp && window.MediApp.showView('classify') }, icon('checklist'), h('span', { text: '업무 분류로 이동' }))));
      return;
    }
    if (!list.length) {
      append(box, h('div', { class: 'card empty-card' },
        h('span', { class: 'empty-icon' }, icon('search_off')),
        h('span', { class: 'title-sm', text: '조건에 맞는 업무가 없습니다' }),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: () => $('db-reset-btn').click() }, icon('filter_alt_off'), h('span', { text: '조건 초기화' }))));
      return;
    }
    if (mode === 'card') {
      append(box, h('div', { class: 'db-cards' }, list.map(taskCard)));
    } else {
      append(box, h('div', { class: 'table-scroll db-table-scroll', tabindex: '0', 'aria-label': '업무 목록 표 (좁은 화면에서는 가로로 스크롤)' },
        h('table', { class: 'db-table' },
          h('thead', null, h('tr', null, ['업무 ID', '등록 일시', '카테고리', '긴급도', '담당자', '진행 상태', '확인 필요'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', null, list.map(taskRow)))));
    }
  }

  function activeChips() {
    const f = S.f; const out = [];
    const q = f.quick && quickDefs().find((x) => x.key === f.quick);
    const set = (patch) => () => { Object.assign(S.f, patch); syncControls(); renderTasks(); };
    if (q) out.push({ label: q.title, clear: set({ quick: '' }) });
    if (f.q.trim()) out.push({ label: '문장: ' + f.q.trim(), clear: set({ q: '' }) });
    if (f.assignee.trim()) out.push({ label: '담당자: ' + f.assignee.trim(), clear: set({ assignee: '' }) });
    if (f.category) out.push({ label: '카테고리: ' + f.category, clear: set({ category: '' }) });
    if (f.urgency) out.push({ label: '긴급도: ' + f.urgency, clear: set({ urgency: '' }) });
    if (f.status) out.push({ label: '상태: ' + f.status, clear: set({ status: '' }) });
    if (f.from || f.to) out.push({ label: '등록: ' + (f.from || '처음') + ' ~ ' + (f.to || '오늘'), clear: set({ from: '', to: '' }) });
    return out;
  }

  const urgPill = (u) => h('span', { class: 'pill urg-pill ' + (URG_CLASS[S.levels.indexOf(u)] || ''), text: u });
  function statusPill(st) {
    const i = STATUSES.indexOf(st);
    return h('span', { class: 'pill db-status', 'data-status': st }, h('span', { class: 'db-swatch', style: 'background:' + STATUS_COLOR[i] }), st);
  }

  function taskCard(t) {
    return h('button', { type: 'button', class: 'db-task-card', 'data-id': t.id, 'aria-label': t.id + ' 상세 보기', onclick: () => openDetail(t.id) },
      h('span', { class: 'db-card-top' },
        h('span', { class: 'pill pill-soft db-cat', text: effCat(t) }),
        urgPill(effUrg(t)),
        statusPill(t.status),
        t.needs_check ? h('span', { class: 'pill db-flag' }, icon('flag', 'icon-14'), '확인 필요') : null,
        t.override ? h('span', { class: 'pill pill-soft', text: '관리자 수정' }) : null),
      h('span', { class: 'db-card-text', text: t.text_masked }),
      h('span', { class: 'db-card-meta' },
        h('span', { class: 'row gap-4' }, icon('person', 'icon-14'), h('span', { text: t.assignee || '담당자 미지정' })),
        h('span', { class: 'code-num', text: fmtDT(t.created_at) })),
      h('span', { class: 'db-card-id code-num', text: t.id }));
  }
  function taskRow(t) {
    return h('tr', { 'data-id': t.id, onclick: (e) => { if (!e.target.closest('button')) openDetail(t.id); } },
      h('th', { scope: 'row' }, h('button', { type: 'button', class: 'db-link code-num', onclick: () => openDetail(t.id), 'aria-label': t.id + ' 상세 보기', text: t.id })),
      h('td', { class: 'code-num', text: fmtDT(t.created_at) }),
      h('td', null, effCat(t), t.override && t.override.category ? h('span', { class: 'db-mod', title: '관리자 수정값', text: '수정' }) : null),
      h('td', null, urgPill(effUrg(t))),
      h('td', { text: t.assignee || '—' }),
      h('td', null, statusPill(t.status)),
      h('td', null, t.needs_check ? h('span', { class: 'db-flag-text' }, icon('flag', 'icon-14'), '필요') : h('span', { class: 'muted', text: '—' })));
  }

  // ---------- 상세 ----------
  function openDetail(id) {
    const t = S.tasks.find((x) => x.id === id);
    const dlg = $('db-dialog');
    if (!t || !dlg) return;
    S.openId = id;
    fillDetail(t);
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  function closeDetail() { const dlg = $('db-dialog'); S.openId = null; if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); } }

  function updateTask(id, fn, msg) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    const before = JSON.stringify(t);
    fn(t);
    t.updated_at = new Date().toISOString();
    if (!saveTasks()) { Object.assign(t, JSON.parse(before)); fillDetail(t); return; }
    renderTasks(); renderStats(); renderData();
    fillDetail(t);
    const st = $('db-dlg-status');
    if (st) st.textContent = (msg || '저장했습니다') + ' · ' + new Date().toLocaleTimeString('ko-KR');
  }

  function fillDetail(t) {
    const dlg = clear($('db-dialog'));
    const c = t.classification;
    const modelName = c.model && window.MediApp ? window.MediApp.modelName(c.model) : null;
    const method = c.method === 'gemini' ? 'Gemini AI' + (c.model ? ' · ' + (modelName ? modelName + ' (' + c.model + ')' : c.model) : '') : (c.fallback ? '규칙 기반 (AI 실패로 대체)' : '규칙 기반');
    const done = t.status === DONE;
    const opt = (v, txt, cur) => h('option', { value: v, text: txt, selected: v === cur });
    append(dlg, h('div', { class: 'db-dlg' },
      h('div', { class: 'db-dlg-head' },
        h('div', { class: 'stack-6' },
          h('span', { class: 'label-xs muted', text: '업무 상세' }),
          h('h2', { class: 'title-sm code-num', id: 'db-dlg-title', text: t.id })),
        h('button', { type: 'button', class: 'db-icon-btn', 'aria-label': '닫기', onclick: closeDetail }, icon('close', 'icon-18'))),
      h('div', { class: 'db-dlg-body' },
        h('div', { class: 'panel' },
          h('div', { class: 'between panel-head' }, h('span', { class: 'label-md', text: '요청 내용 (개인정보 가림)' })),
          h('p', { class: 'body-sm masked-text', text: t.text_masked })),

        h('div', { class: 'panel' },
          h('span', { class: 'label-md', text: '원래 분류 결과 (보존)' }),
          h('div', { class: 'db-kv' },
            kv('업무 유형', c.category), kv('긴급도', c.urgency),
            kv('분류 방식', method), kv('분류 기준', c.criteria_version != null ? 'criteria v' + c.criteria_version : '—')),
          h('span', { class: 'label-xs muted', text: '분류 판단 근거' }),
          h('p', { class: 'body-sm', text: c.reason || '—' })),

        h('div', { class: 'db-form' },
          h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '진행 상태' }),
            h('select', { class: 'select', id: 'db-dlg-status-sel', onchange: (e) => setStatus(t.id, e.target.value) }, STATUSES.map((x) => opt(x, x, t.status)))),
          h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '담당자 (선택, 실명 대신 팀·역할명 권장)' }),
            h('span', { class: 'db-inline' },
              h('input', { class: 'db-input', id: 'db-dlg-assignee', type: 'text', maxlength: String(MAX_ASSIGNEE), value: t.assignee || '', placeholder: '예: 콘텐츠팀 A', autocomplete: 'off',
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveAssignee(t.id); } } }),
              h('button', { type: 'button', class: 'btn btn-small btn-secondary', id: 'db-dlg-assignee-save', onclick: () => saveAssignee(t.id), text: '저장' }))),
          h('label', { class: 'db-check' },
            h('input', { type: 'checkbox', id: 'db-dlg-check', checked: t.needs_check, onchange: (e) => updateTask(t.id, (x) => { x.needs_check = e.target.checked; }, e.target.checked ? '추가확인 필요로 표시했습니다' : '추가확인 필요 표시를 해제했습니다') }),
            h('span', null, h('span', { class: 'label-md block', text: '추가확인 필요' }), h('span', { class: 'label-xs muted', text: '내용 확인이 더 필요한 업무로 표시합니다' }))),
          h('button', { type: 'button', class: 'btn ' + (done ? 'btn-tonal' : 'btn-primary'), id: 'db-dlg-done',
            onclick: () => setStatus(t.id, done ? (t.prev_status || '진행중') : DONE) },
            icon(done ? 'undo' : 'task_alt', 'icon-18'), h('span', { text: done ? '완료 취소' : '완료 처리' })),
          h('p', { class: 'label-xs muted', text: done ? '완료 일시: ' + fmtDT(t.completed_at) + ' · 완료 취소 시 이전 상태(' + (t.prev_status || '진행중') + ')로 돌아갑니다' : '완료 처리하면 완료 일시가 기록됩니다' })),

        h('div', { class: 'panel' },
          h('span', { class: 'label-md', text: '관리자 수정 (선택)' }),
          h('span', { class: 'label-xs muted', text: '원래 분류 결과는 그대로 두고 수정값을 따로 저장합니다. 목록·통계는 수정값을 우선 사용합니다.' }),
          h('div', { class: 'db-form-2' },
            h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '업무 유형' }),
              h('select', { class: 'select', id: 'db-dlg-ov-cat', onchange: (e) => setOverride(t.id, 'category', e.target.value) },
                opt('', '원래 분류 사용 (' + c.category + ')', (t.override && t.override.category) || ''), S.cats.filter((x) => x !== c.category).map((x) => opt(x, x, (t.override && t.override.category) || '')))),
            h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '긴급도' }),
              h('select', { class: 'select', id: 'db-dlg-ov-urg', onchange: (e) => setOverride(t.id, 'urgency', e.target.value) },
                opt('', '원래 분류 사용 (' + c.urgency + ')', (t.override && t.override.urgency) || ''), S.levels.filter((x) => x !== c.urgency).map((x) => opt(x, x, (t.override && t.override.urgency) || '')))))),

        h('div', { class: 'db-kv db-meta' },
          kv('등록 일시', fmtDT(t.created_at)), kv('완료 일시', fmtDT(t.completed_at)), kv('최종 수정', fmtDT(t.updated_at))),
        h('p', { class: 'label-xs db-dlg-status', id: 'db-dlg-status', role: 'status', 'aria-live': 'polite' }),
        h('div', { class: 'db-dlg-foot' },
          h('button', { type: 'button', class: 'btn btn-small btn-danger', id: 'db-dlg-delete', onclick: () => confirmInline('db-dlg-confirm', '이 업무(' + t.id + ')를 삭제할까요? 되돌릴 수 없습니다.', () => {
            const keep = S.tasks.slice();
            S.tasks = S.tasks.filter((x) => x.id !== t.id);
            if (!saveTasks()) { S.tasks = keep; return; }
            closeDetail(); renderAll(); refreshSaveButton(); toast(t.id + ' 업무를 삭제했습니다.');
          }) }, icon('delete'), h('span', { text: '업무 삭제' })),
          h('button', { type: 'button', class: 'btn btn-small btn-tonal', onclick: closeDetail, text: '닫기' })),
        h('div', { id: 'db-dlg-confirm' }))));
  }
  const kv = (k, v) => h('div', { class: 'db-kv-row' }, h('span', { class: 'label-xs muted', text: k }), h('span', { class: 'body-sm db-kv-v', text: v }));

  function setStatus(id, st) {
    if (!STATUSES.includes(st)) return;
    updateTask(id, (t) => {
      if (st === t.status) return;
      if (st === DONE) { t.prev_status = t.status; t.completed_at = new Date().toISOString(); }
      else { t.completed_at = null; if (t.status === DONE) t.prev_status = null; }
      t.status = st;
    }, "진행 상태를 '" + st + "'(으)로 바꿨습니다");
  }
  function saveAssignee(id) {
    const v = ($('db-dlg-assignee').value || '').trim().slice(0, MAX_ASSIGNEE);
    updateTask(id, (t) => { t.assignee = v; }, v ? '담당자를 저장했습니다' : '담당자를 비웠습니다');
  }
  function setOverride(id, field, v) {
    updateTask(id, (t) => {
      const o = Object.assign({ category: null, urgency: null }, t.override || {});
      o[field] = v || null;
      o.updated_at = new Date().toISOString();
      t.override = o.category || o.urgency ? o : null;
    }, v ? '관리자 수정값을 저장했습니다 (원래 분류는 보존)' : '원래 분류로 되돌렸습니다');
  }

  // ---------- 통계 ----------
  function renderStats() {
    const T = S.tasks;
    $('db-stats-source').textContent = '출처: 업무 기록 ' + T.length + '건 · 평가 데이터 미포함';
    const box = clear($('db-stats'));
    if (!T.length) {
      append(box, h('div', { class: 'card empty-card' }, h('span', { class: 'empty-icon' }, icon('bar_chart')),
        h('span', { class: 'title-sm', text: '통계를 낼 업무 기록이 없습니다' }),
        h('span', { class: 'label-xs muted', text: '업무를 저장하면 카테고리별 요청량·긴급도·진행 현황이 자동으로 계산됩니다.' })));
      return;
    }
    const done = T.filter((t) => !isOpen(t)).length;
    const check = T.filter((t) => t.needs_check).length;
    append(box, h('div', { class: 'db-kpis' },
      kpi('전체 업무 요청', T.length + '건', '저장된 업무 기록'),
      kpi('미해결', (T.length - done) + '건', '완료 제외'),
      kpi('완료', done + '건', '완료율 ' + pct(done, T.length)),
      kpi('추가확인 필요', check + '건', '확인 필요 표시')));
    const per = S.cats.map((c) => {
      const ts = T.filter((t) => effCat(t) === c);
      return { cat: c, n: ts.length, open: ts.filter(isOpen).length, done: ts.filter((t) => !isOpen(t)).length, check: ts.filter((t) => t.needs_check).length,
        urg: S.levels.map((l) => ts.filter((t) => effUrg(t) === l).length), st: STATUSES.map((s2) => ts.filter((t) => t.status === s2).length) };
    });
    append(box, h('div', { class: 'db-charts' },
      chartCard('카테고리별 요청량', '건수와 전체 대비 비중', catBars(per, T.length)),
      chartCard('긴급도별 비중', '관리자 수정값 우선', urgDonut(T)),
      chartCard('카테고리별 진행 상태', '상태별 누적 건수', statusStack(per)),
      chartCard('날짜별 등록 추이', '최근 기간의 일별 등록 건수', dateLine(T), 'db-chart-wide'),
      chartCard('카테고리별 완료 현황', '미해결 대비 완료 건수', doneBars(per)),
      chartCard('카테고리별 상세 표', '표로 보기 (모든 수치)', statsTable(per, T.length), 'db-chart-wide')));
  }
  const kpi = (label, value, sub) => h('div', { class: 'metric db-kpi' }, h('span', { class: 'label-xs muted', text: label }), h('div', { class: 'metric-value has-value', text: value }), h('span', { class: 'metric-sub', text: sub }));
  function chartCard(title, sub, body, cls) {
    return h('div', { class: 'card db-chart ' + (cls || '') },
      h('div', { class: 'stack-6' }, h('h3', { class: 'title-sm', text: title }), h('span', { class: 'label-xs muted', text: sub })), body);
  }
  function legend(items) {
    return h('div', { class: 'db-legend' }, items.map((it) => it.onclick
      ? h('button', { type: 'button', class: 'db-legend-item', onclick: it.onclick, 'aria-label': it.aria || it.label }, h('span', { class: 'db-swatch', style: 'background:' + it.color }), h('span', { text: it.label }))
      : h('span', { class: 'db-legend-item' }, h('span', { class: 'db-swatch', style: 'background:' + it.color }), h('span', { text: it.label }))));
  }

  function catBars(per, total) {
    const max = Math.max(1, ...per.map((p) => p.n));
    return h('div', { class: 'db-bars' }, per.map((p) => {
      const tip = p.cat + ': ' + p.n + '건 (' + pct(p.n, total) + ')';
      return h('button', { type: 'button', class: 'db-bar-row', 'data-tip': tip, 'aria-label': tip + ' — 목록에서 보기', 'data-chart': 'cat', 'data-value': p.cat,
        onclick: () => applyFilter({ category: p.cat }, true) },
        h('span', { class: 'db-bar-label', text: p.cat }),
        h('span', { class: 'db-bar-track' }, h('span', { class: 'db-bar', style: 'width:' + (p.n / max * 100) + '%;background:' + BAR_COLOR })),
        h('span', { class: 'db-bar-val code-num', text: p.n + '건 · ' + pct(p.n, total) }));
    }));
  }

  function urgDonut(T) {
    const counts = S.levels.map((l) => T.filter((t) => effUrg(t) === l).length);
    const total = T.length;
    const R = 52, C = 2 * Math.PI * R;
    const nonZero = counts.filter((n) => n > 0).length;
    const gap = nonZero > 1 ? 2 : 0;
    const svg = s('svg', { viewBox: '0 0 140 140', class: 'db-donut', role: 'img', 'aria-label': '긴급도 비중: ' + S.levels.map((l, i) => l + ' ' + counts[i] + '건').join(', ') });
    svg.appendChild(s('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: '#e8edff', 'stroke-width': 18 }));
    let off = 0;
    counts.forEach((n, i) => {
      if (!n) return;
      const len = n / total * C;
      const seg = s('circle', { cx: 70, cy: 70, r: R, fill: 'none', stroke: URG_COLOR[i], 'stroke-width': 18,
        'stroke-dasharray': Math.max(0, len - gap) + ' ' + (C - Math.max(0, len - gap)), 'stroke-dashoffset': String(-off), transform: 'rotate(-90 70 70)',
        'data-tip': S.levels[i] + ': ' + n + '건 (' + pct(n, total) + ')', class: 'db-donut-seg', 'data-chart': 'urg', 'data-value': S.levels[i] });
      seg.addEventListener('click', () => applyFilter({ urgency: S.levels[i] }, true));
      svg.appendChild(seg);
      off += len;
    });
    const t1 = s('text', { x: 70, y: 68, 'text-anchor': 'middle', class: 'db-donut-num' }); t1.textContent = String(total);
    const t2 = s('text', { x: 70, y: 86, 'text-anchor': 'middle', class: 'db-donut-sub' }); t2.textContent = '전체 건수';
    svg.appendChild(t1); svg.appendChild(t2);
    return h('div', { class: 'db-donut-wrap' }, svg,
      h('div', { class: 'db-donut-legend' }, S.levels.map((l, i) => h('button', { type: 'button', class: 'db-legend-row', 'data-chart': 'urg-legend', 'data-value': l,
        'aria-label': l + ' ' + counts[i] + '건 — 목록에서 보기', onclick: () => applyFilter({ urgency: l }, true) },
        h('span', { class: 'db-swatch', style: 'background:' + URG_COLOR[i] }), h('span', { class: 'db-legend-name', text: l }),
        h('span', { class: 'code-num', text: counts[i] + '건 · ' + pct(counts[i], total) })))));
  }

  function statusStack(per) {
    const max = Math.max(1, ...per.map((p) => p.n));
    return h('div', { class: 'stack-8' },
      legend(STATUSES.map((st, i) => ({ label: st, color: STATUS_COLOR[i], aria: st + ' 업무 목록에서 보기', onclick: () => applyFilter({ status: st }, true) }))),
      h('div', { class: 'db-bars' }, per.map((p) => h('div', { class: 'db-bar-row is-static' },
        h('span', { class: 'db-bar-label', text: p.cat }),
        h('span', { class: 'db-bar-track db-stack' }, p.st.map((n, i) => n ? h('button', { type: 'button', class: 'db-seg', style: 'width:' + (n / max * 100) + '%;background:' + STATUS_COLOR[i],
          'data-tip': p.cat + ' · ' + STATUSES[i] + ': ' + n + '건', 'aria-label': p.cat + ' ' + STATUSES[i] + ' ' + n + '건 — 목록에서 보기', 'data-chart': 'stack', 'data-value': p.cat + '|' + STATUSES[i],
          onclick: () => applyFilter({ category: p.cat, status: STATUSES[i] }, true) }) : null)),
        h('span', { class: 'db-bar-val code-num', text: p.n + '건' })))));
  }

  function dateLine(T) {
    const days = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const minDay = T.reduce((m, t) => (dayOf(t.created_at) < m ? dayOf(t.created_at) : m), dayOf(today.toISOString()));
    let start = new Date(today); start.setDate(start.getDate() - 13);
    const min = new Date(minDay + 'T00:00:00');
    const earliest = new Date(today); earliest.setDate(earliest.getDate() - 29);
    if (min < start) start = min < earliest ? earliest : min;
    for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) days.push(dayOf(d.toISOString()));
    const counts = days.map((d) => T.filter((t) => dayOf(t.created_at) === d).length);
    const outside = T.length - counts.reduce((a, b) => a + b, 0);
    const maxV = Math.max(1, ...counts);
    const step = maxV <= 4 ? 1 : Math.ceil(maxV / 4);
    const top = Math.ceil(maxV / step) * step;
    const W = 640, H = 220, L = 34, R = 12, TP = 14, B = 30;
    const x = (i) => L + (days.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (days.length - 1));
    const y = (v) => TP + (H - TP - B) * (1 - v / top);
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'db-line', role: 'img', 'aria-label': '날짜별 등록 건수 (' + days[0] + ' ~ ' + days[days.length - 1] + ')' });
    for (let v = 0; v <= top; v += step) {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'db-axis' : 'db-grid' }));
      const tx = s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'db-tick' }); tx.textContent = String(v); svg.appendChild(tx);
    }
    const every = Math.ceil(days.length / 7);
    days.forEach((d, i) => {
      if (i % every !== 0 && i !== days.length - 1) return;
      const tx = s('text', { x: x(i), y: H - 10, 'text-anchor': 'middle', class: 'db-tick' }); tx.textContent = d.slice(5).replace('-', '/'); svg.appendChild(tx);
    });
    svg.appendChild(s('polyline', { points: counts.map((v, i) => x(i) + ',' + y(v)).join(' '), fill: 'none', stroke: BAR_COLOR, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    counts.forEach((v, i) => {
      if (v) svg.appendChild(s('circle', { cx: x(i), cy: y(v), r: 4, fill: BAR_COLOR, stroke: '#fff', 'stroke-width': 2 }));
      const colW = (W - L - R) / Math.max(1, days.length - 1);
      const hit = s('rect', { x: x(i) - colW / 2, y: TP, width: colW, height: H - TP - B, fill: 'transparent', class: 'db-hit', 'data-tip': days[i] + ' · ' + v + '건', 'data-chart': 'date', 'data-value': days[i] });
      hit.addEventListener('click', () => applyFilter({ from: days[i], to: days[i] }, true));
      svg.appendChild(hit);
    });
    return h('div', { class: 'stack-8' }, h('div', { class: 'db-line-wrap' }, svg),
      outside ? h('p', { class: 'label-xs muted', text: '표시 기간(최근 30일) 이전에 등록한 업무 ' + outside + '건은 그래프에서 빠졌습니다. 등록 기간 필터로 확인하세요.' }) : null,
      h('details', { class: 'db-details' }, h('summary', { class: 'label-md', text: '날짜별 표로 보기' }),
        h('div', { class: 'db-day-list' }, days.map((d, i) => counts[i] ? h('button', { type: 'button', class: 'db-day', onclick: () => applyFilter({ from: d, to: d }, true), 'aria-label': d + ' 등록 ' + counts[i] + '건 — 목록에서 보기' },
          h('span', { class: 'code-num', text: d }), h('span', { class: 'code-num', text: counts[i] + '건' })) : null).filter(Boolean))));
  }

  function doneBars(per) {
    const max = Math.max(1, ...per.map((p) => Math.max(p.open, p.done)));
    return h('div', { class: 'stack-8' },
      legend([{ label: '미해결', color: OPEN_COLOR }, { label: '완료', color: DONE_COLOR }]),
      h('div', { class: 'db-bars' }, per.map((p) => h('div', { class: 'db-bar-row is-static db-pair' },
        h('span', { class: 'db-bar-label', text: p.cat }),
        h('span', { class: 'db-pair-bars' },
          pairBar(p, 'open', p.open, max, OPEN_COLOR, '미해결', () => applyFilter({ category: p.cat, quick: 'open', status: '' }, true)),
          pairBar(p, 'done', p.done, max, DONE_COLOR, '완료', () => applyFilter({ category: p.cat, status: DONE, quick: '' }, true)))))));
  }
  function pairBar(p, key, n, max, color, label, fn) {
    return h('button', { type: 'button', class: 'db-pair-row', 'data-tip': p.cat + ' · ' + label + ': ' + n + '건', 'aria-label': p.cat + ' ' + label + ' ' + n + '건 — 목록에서 보기', 'data-chart': 'done-' + key, 'data-value': p.cat, onclick: fn },
      h('span', { class: 'db-bar-track thin' }, h('span', { class: 'db-bar', style: 'width:' + (n / max * 100) + '%;background:' + color })),
      h('span', { class: 'db-bar-val code-num', text: label + ' ' + n }));
  }

  function statsTable(per, total) {
    return h('div', { class: 'table-scroll', tabindex: '0', 'aria-label': '카테고리별 상세 표 (가로 스크롤)' },
      h('table', { class: 'db-table db-stats-table' },
        h('thead', null, h('tr', null, ['카테고리', '건수', '비중'].concat(S.levels.map((l) => '긴급 ' + l), ['미해결', '완료', '확인 필요']).map((x) => h('th', { scope: 'col', text: x })))),
        h('tbody', null, per.map((p) => h('tr', null,
          h('th', { scope: 'row' }, h('button', { type: 'button', class: 'db-link', onclick: () => applyFilter({ category: p.cat }, true), text: p.cat })),
          h('td', { class: 'code-num', text: String(p.n) }), h('td', { class: 'code-num', text: pct(p.n, total) }),
          p.urg.map((n) => h('td', { class: 'code-num', text: String(n) })),
          h('td', { class: 'code-num', text: String(p.open) }), h('td', { class: 'code-num', text: String(p.done) }), h('td', { class: 'code-num', text: String(p.check) })))),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row', text: '합계' }), h('td', { class: 'code-num', text: String(total) }), h('td', { class: 'code-num', text: total ? '100.0%' : '0.0%' }),
          S.levels.map((l, i) => h('td', { class: 'code-num', text: String(per.reduce((a, p) => a + p.urg[i], 0)) })),
          h('td', { class: 'code-num', text: String(per.reduce((a, p) => a + p.open, 0)) }), h('td', { class: 'code-num', text: String(per.reduce((a, p) => a + p.done, 0)) }), h('td', { class: 'code-num', text: String(per.reduce((a, p) => a + p.check, 0)) })))));
  }

  // ---------- AI 성능 ----------
  const runsSorted = () => S.evals.runs.slice().sort((a, b) => a.started_at.localeCompare(b.started_at) || a.run - b.run);
  const importNo = (id) => S.evals.imports.findIndex((x) => x.import_id === id) + 1;
  const runName = (r) => (r.display_name || r.model_id) + ' · ' + r.run + '차';
  function sibling(r) { return S.evals.runs.find((x) => x !== r && x.import_id === r.import_id && x.model_id === r.model_id && x.run !== r.run && Math.abs(x.run - r.run) === 1 && Math.min(x.run, r.run) % 2 === 1); }
  function agreement(a, b) {
    const map = new Map(b.items.map((i) => [i.id, i]));
    let both = 0, n = 0;
    a.items.forEach((i) => { const j = map.get(i.id); if (!j) return; n++; if (!i.failed && !j.failed && i.pred_category === j.pred_category && i.pred_urgency === j.pred_urgency) both++; });
    return { both: both, n: n };
  }
  function errType(i) { if (i.failed) return '응답 실패'; if (!i.category_correct && !i.urgency_correct) return '모두 오류'; return !i.category_correct ? '업무 유형 오류' : '긴급도 오류'; }

  function renderAI() {
    const runs = runsSorted();
    $('db-ai-source').textContent = '출처: 가져온 평가 ' + runs.length + '개 회차 · 업무 기록 미포함';
    const sessBtn = $('db-eval-session-btn');
    const rep = window.MediApp && window.MediApp.aiReport ? window.MediApp.aiReport() : null;
    sessBtn.disabled = !rep;
    sessBtn.title = rep ? '' : '성능 평가 탭에서 AI 채점을 먼저 실행하세요';
    const box = clear($('db-ai'));
    if (!runs.length) {
      append(box, h('div', { class: 'card empty-card' }, h('span', { class: 'empty-icon' }, icon('model_training')),
        h('span', { class: 'title-sm', text: '가져온 평가 결과가 없습니다' }),
        h('span', { class: 'label-xs muted', text: '위에서 ai_채점결과.json을 가져오거나, 성능 평가 탭에서 AI 채점을 실행한 뒤 "현재 성능 평가 탭 결과 가져오기"를 누르세요.' })));
      return;
    }
    if (!runs.some((r) => r.key === S.selRun)) S.selRun = runs[runs.length - 1].key;
    const r = runs.find((x) => x.key === S.selRun);
    const sm = r.summary;
    const sib = sibling(r);
    const agr = sib ? agreement(r, sib) : null;
    const runSel = h('select', { class: 'select', id: 'db-run-sel', onchange: (e) => { S.selRun = e.target.value; renderAI(); } },
      runs.map((x) => h('option', { value: x.key, selected: x.key === S.selRun, text: runName(x) + ' · ' + fmtDT(x.started_at) + ' · 가져오기 #' + importNo(x.import_id) })));

    append(box, h('div', { class: 'card db-ai-kpi' },
      h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '표시할 평가 회차' }), runSel),
      h('div', { class: 'db-ai-grid' },
        aiTile('업무 유형 정확도', pct(sm.category_correct, sm.total), sm.category_correct + ' / ' + sm.total + ' 일치'),
        aiTile('긴급도 정확도', pct(sm.urgency_correct, sm.total), sm.urgency_correct + ' / ' + sm.total + ' 일치'),
        aiTile('완전 일치율', pct(sm.exact_match, sm.total), sm.exact_match + ' / ' + sm.total + ' 일치', true),
        aiTile('오분류 건수', sm.misclassified + '건', '응답 실패 ' + sm.failed + '건 포함'),
        aiTile('평가 문장 수', sm.total + '건', '정답 있는 평가 문장'),
        aiTile('1·2차 일관성', agr ? pct(agr.both, agr.n) : '—', agr ? agr.both + ' / ' + agr.n + ' 문장 같은 결과 (' + sib.run + '차와 비교)' : '같은 가져오기에 짝 회차 없음')),
      h('div', { class: 'db-kv' },
        kv('사용 모델', (r.display_name ? r.display_name + ' · ' : '') + r.model_id + (r.stage === 'preview' ? ' · Preview' : '')),
        kv('평가 회차', r.run + '차 (가져오기 #' + importNo(r.import_id) + ')'),
        kv('평균 응답 시간', sec(r.avg_response_ms)),
        kv('평가 일시', fmtDT(r.started_at)))));

    // 규칙 vs Gemini 비교표
    const bases = S.evals.baselines;
    const rows = [];
    bases.forEach((b) => rows.push({ name: '규칙 기반', sub: '기준선 · 가져오기 #' + importNo(b.import_id), run: '기준선', at: '—', sm: b.summary, ms: '—', base: true }));
    runs.forEach((x) => rows.push({ name: x.display_name || x.model_id, sub: x.model_id, run: x.run + '차', at: fmtDT(x.started_at), sm: x.summary, ms: sec(x.avg_response_ms), sel: x.key === S.selRun }));
    const LBL = ['모델', '회차', '평가 일시', '업무 유형', '긴급도', '완전 일치', '오분류', '실패', '평균 응답'];
    append(box, h('div', { class: 'card' },
      h('div', { class: 'between' }, h('div', { class: 'row gap-6' }, icon('compare_arrows', 'icon-18 text-primary'), h('h3', { class: 'title-sm', text: '규칙 기반 vs Gemini 비교' })),
        h('span', { class: 'pill pill-soft', text: rows.length + '행' })),
      h('div', { class: 'table-scroll db-cmp-scroll', tabindex: '0', 'aria-label': '규칙 기반과 Gemini 비교표' },
        h('table', { class: 'compare db-cmp' },
          h('thead', null, h('tr', null, LBL.map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', null, rows.map((x) => h('tr', { class: (x.base ? 'is-baseline' : '') + (x.sel ? ' is-sel' : '') },
            h('th', { scope: 'row', 'data-label': LBL[0] }, h('span', { class: 'model-name', text: x.name }), h('span', { class: 'model-id', text: x.sub })),
            [x.run, x.at, pct(x.sm.category_correct, x.sm.total), pct(x.sm.urgency_correct, x.sm.total), pct(x.sm.exact_match, x.sm.total), x.sm.misclassified + '건', x.sm.failed + '건', x.ms]
              .map((v, i) => h('td', { 'data-label': LBL[i + 1], class: i >= 2 ? 'has-value' : '', text: v }))))))),
      bases.length ? null : h('p', { class: 'label-xs muted', text: '가져온 파일에 규칙 기반 결과가 없어 규칙 행을 표시하지 않았습니다.' })));

    // 회차별 성능 변화
    append(box, chartCard('평가 회차별 성능 변화', '가져온 회차를 평가 일시 순으로 표시 (정확도 %)', trendChart(runs), 'db-trend-card'));

    // 오분류 분석
    if (S.misRun !== 'all' && !runs.some((x) => x.key === S.misRun)) S.misRun = 'all';
    const target = S.misRun === 'all' ? runs : runs.filter((x) => x.key === S.misRun);
    const mis = [];
    target.forEach((x) => x.items.forEach((i) => { if (!i.exact_match) mis.push({ i: i, r: x }); }));
    const byCat = S.cats.map((c) => ({ cat: c, n: mis.filter((m) => m.i.gold_category === c).length, catErr: mis.filter((m) => m.i.gold_category === c && !m.i.category_correct).length }));
    const maxC = Math.max(1, ...byCat.map((b) => b.n));
    append(box, h('div', { class: 'card db-mis' },
      h('div', { class: 'between db-mis-head' }, h('div', { class: 'row gap-6' }, icon('troubleshoot', 'icon-18 text-primary'), h('h3', { class: 'title-sm', text: 'AI 오분류 분석' })),
        h('span', { class: 'pill pill-error', text: mis.length + '건' })),
      h('label', { class: 'db-field' }, h('span', { class: 'label-xs muted', text: '분석 대상' }),
        h('select', { class: 'select', id: 'db-mis-sel', onchange: (e) => { S.misRun = e.target.value; renderAI(); } },
          h('option', { value: 'all', text: '가져온 모든 회차 (' + runs.length + '개)', selected: S.misRun === 'all' }),
          runs.map((x) => h('option', { value: x.key, selected: x.key === S.misRun, text: runName(x) + ' · ' + fmtDT(x.started_at) })))),
      h('div', { class: 'stack-6' }, h('span', { class: 'label-md', text: '정답 카테고리별 오분류 건수' }),
        h('div', { class: 'db-bars' }, byCat.map((b) => h('div', { class: 'db-bar-row is-static', 'data-tip': b.cat + ': 오분류 ' + b.n + '건 (그중 업무 유형 오류 ' + b.catErr + '건)', tabindex: '0' },
          h('span', { class: 'db-bar-label', text: b.cat }),
          h('span', { class: 'db-bar-track' }, h('span', { class: 'db-bar', style: 'width:' + (b.n / maxC * 100) + '%;background:' + BAR_COLOR })),
          h('span', { class: 'db-bar-val code-num', text: b.n + '건 (유형 ' + b.catErr + ')' }))))),
      mis.length ? h('div', { class: 'table-scroll', tabindex: '0', 'aria-label': '오분류 목록 (가로 스크롤)' },
        h('table', { class: 'db-table db-mis-table' },
          h('thead', null, h('tr', null, ['문장 ID', '정답 카테고리', 'AI 예측 카테고리', '정답 긴급도', 'AI 예측 긴급도', '오분류 유형', '사용 모델', '평가 회차'].map((x) => h('th', { scope: 'col', text: x })))),
          h('tbody', null, mis.map((m) => h('tr', null,
            h('th', { scope: 'row', class: 'code-num', text: m.i.id }),
            h('td', { text: m.i.gold_category }),
            h('td', { class: m.i.category_correct ? '' : 'db-wrong', text: m.i.pred_category || '응답 없음' }),
            h('td', { text: m.i.gold_urgency }),
            h('td', { class: m.i.urgency_correct ? '' : 'db-wrong', text: m.i.pred_urgency || '응답 없음' }),
            h('td', null, h('span', { class: 'pill pill-error', text: errType(m.i) })),
            h('td', { class: 'db-model-cell', text: m.r.display_name || m.r.model_id }),
            h('td', { text: m.r.run + '차 · #' + importNo(m.r.import_id) })))))) : h('p', { class: 'label-xs muted', text: '선택한 회차에 오분류가 없습니다.' })));
  }
  const aiTile = (label, value, sub, strong) => h('div', { class: 'metric db-ai-tile' }, h('span', { class: 'label-xs muted', text: label }),
    h('div', { class: 'metric-value has-value' + (strong ? ' text-primary-strong' : ''), text: value }), h('span', { class: 'metric-sub', text: sub }));

  function trendChart(runs) {
    const W = 640, H = 230, L = 40, R = 76, TP = 14, B = 34;
    const n = runs.length;
    const x = (i) => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
    const y = (v) => TP + (H - TP - B) * (1 - v / 100);
    const val = (r, k) => { const m = r.summary; return Math.round((k === 'cat' ? m.category_correct : k === 'urg' ? m.urgency_correct : m.exact_match) / m.total * 1000) / 10; };
    const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'db-line', role: 'img', 'aria-label': '평가 회차별 정확도 변화 (' + n + '개 회차)' });
    [0, 25, 50, 75, 100].forEach((v) => {
      svg.appendChild(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'db-axis' : 'db-grid' }));
      const t = s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'db-tick' }); t.textContent = v + '%'; svg.appendChild(t);
    });
    const every = Math.ceil(n / 8);
    runs.forEach((r, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const t = s('text', { x: x(i), y: H - 12, 'text-anchor': 'middle', class: 'db-tick' }); t.textContent = '#' + (i + 1); svg.appendChild(t);
    });
    // 끝 라벨이 겹치지 않도록 세로 위치를 벌린다
    const ends = TREND.map((tr) => ({ tr: tr, v: val(runs[n - 1], tr.key) })).sort((a, b) => b.v - a.v);
    let lastY = -Infinity;
    ends.forEach((e) => { e.y = Math.max(y(e.v) + 4, lastY + 14); lastY = e.y; });
    TREND.forEach((tr) => {
      svg.appendChild(s('polyline', { points: runs.map((r, i) => x(i) + ',' + y(val(r, tr.key))).join(' '), fill: 'none', stroke: tr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      runs.forEach((r, i) => svg.appendChild(s('circle', { cx: x(i), cy: y(val(r, tr.key)), r: 4, fill: tr.color, stroke: '#fff', 'stroke-width': 2 })));
      const e = ends.find((q) => q.tr === tr);
      const t = s('text', { x: x(n - 1) + 10, y: e.y, class: 'db-end-label' }); t.textContent = tr.label + ' ' + e.v.toFixed(1); svg.appendChild(t);
    });
    const colW = n === 1 ? W - L - R : (W - L - R) / (n - 1);
    runs.forEach((r, i) => {
      svg.appendChild(s('rect', { x: x(i) - colW / 2, y: TP, width: colW, height: H - TP - B, fill: 'transparent', class: 'db-hit',
        'data-tip': '#' + (i + 1) + ' ' + runName(r) + ' (' + fmtDT(r.started_at) + ') — ' + TREND.map((tr) => tr.label + ' ' + val(r, tr.key).toFixed(1) + '%').join(', ') }));
    });
    return h('div', { class: 'stack-8' }, legend(TREND.map((t) => ({ label: t.label + ' 정확도', color: t.color }))), h('div', { class: 'db-line-wrap' }, svg),
      h('p', { class: 'label-xs muted', text: '가로축 #번호는 위 비교표의 회차 순서(평가 일시 순)입니다. 같은 모델의 회차끼리만 비교하세요.' }));
  }

  // ---------- 데이터 관리 ----------
  function renderData() {
    $('db-count-tasks').textContent = S.tasks.length + '건';
    $('db-count-evals').textContent = S.evals.runs.length + '개 회차';
    $('db-tasks-csv').disabled = $('db-tasks-json').disabled = !S.tasks.length;
    $('db-evals-csv').disabled = $('db-evals-json').disabled = !S.evals.runs.length && !S.evals.baselines.length;
    $('db-tasks-delete').disabled = !S.tasks.length && !S.taskErr;
    $('db-evals-delete').disabled = !S.evals.imports.length && !S.evalErr;
    const list = clear($('db-import-list'));
    S.evals.imports.forEach((im, idx) => {
      const rs = S.evals.runs.filter((r) => r.import_id === im.import_id);
      const bs = S.evals.baselines.filter((b) => b.import_id === im.import_id);
      append(list, h('div', { class: 'db-import-item' },
        h('div', { class: 'stack-6' },
          h('span', { class: 'label-md', text: '가져오기 #' + (idx + 1) + ' · ' + im.source }),
          h('span', { class: 'label-xs muted', text: fmtDT(im.imported_at) + ' 가져옴 · 회차 ' + rs.length + '개' + (bs.length ? ' · 규칙 기준선' : '') + ' · 문장 ' + im.dataset_count + '개' })),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', 'aria-label': '가져오기 #' + (idx + 1) + ' 삭제',
          onclick: () => confirmInline('db-confirm-evals', '가져오기 #' + (idx + 1) + '(' + im.source + ')의 기록을 삭제할까요?', () => {
            const keep = JSON.parse(JSON.stringify(S.evals));
            S.evals.imports = S.evals.imports.filter((x) => x.import_id !== im.import_id);
            S.evals.runs = S.evals.runs.filter((x) => x.import_id !== im.import_id);
            S.evals.baselines = S.evals.baselines.filter((x) => x.import_id !== im.import_id);
            if (!saveEvals()) { S.evals = keep; return; }
            renderAll(); toast('가져오기 기록을 삭제했습니다.');
          }) }, icon('delete'), h('span', { text: '삭제' }))));
    });
  }

  // ======================= 가져오기 =======================
  async function readJsonFile(file) {
    if (file.size > MAX_FILE) return { error: '파일이 2MB를 넘습니다' };
    let text;
    try { text = await file.text(); } catch (e) { return { error: '파일을 읽지 못했습니다' }; }
    try { return { data: JSON.parse(text.replace(/^﻿/, '')) }; } catch (e) { return { error: 'JSON 형식이 아닙니다', kind: 'json' }; }
  }

  function showImportResult(checks, summary, ok) {
    const box = $('db-import-result');
    clear(box).hidden = false;
    box.className = 'db-import-result ' + (ok ? 'is-ok' : 'is-fail');
    append(box,
      h('span', { class: 'label-md', text: summary }),
      h('ul', { class: 'db-checks' }, checks.map((c) => h('li', { class: c.state }, icon(c.state === 'pass' ? 'check_circle' : c.state === 'fail' ? 'cancel' : 'radio_button_unchecked', 'icon-15'),
        h('span', null, h('span', { class: 'label-xs db-check-name', text: c.label }), c.detail ? h('span', { class: 'label-xs muted', text: ' — ' + c.detail }) : null)))));
  }

  function importEvalData(d, source) {
    const steps = ['JSON 형식', '필수 항목', '값 범위 (업무 유형·긴급도)', '요약 수치 재계산', '중복 확인'];
    const checks = steps.map((x) => ({ label: x, state: 'wait', detail: '' }));
    const fail = (kind, msg) => {
      const at = { json: 0, required: 1, range: 2, calc: 3 }[kind];
      const idx = at == null ? 1 : at;
      for (let i = 0; i < idx; i++) checks[i].state = 'pass';
      checks[idx].state = 'fail'; checks[idx].detail = msg;
      showImportResult(checks, '가져오지 않았습니다 (저장된 기록은 바뀌지 않음)', false);
      toast('평가 결과를 가져오지 못했습니다: ' + msg, 'error');
    };
    if (d.error) return fail(d.kind || 'json', d.error);
    if (S.evalErr) return fail('required', '저장된 평가 기록에 문제가 있어 가져오기를 멈췄습니다');
    const data = d.data;
    let runs, baselines, meta;
    if (data && data.schema === 'meditask.evals') {
      const v = parseEvalStore(data);
      if (v.error) return fail(v.kind || 'required', v.error);
      // 내보낸 파일: 원래 가져오기 단위를 유지한다
      const added = { runs: 0, base: 0, skipped: 0 };
      const next = JSON.parse(JSON.stringify(S.evals));
      v.store.imports.forEach((im) => {
        const rs = v.store.runs.filter((r) => r.import_id === im.import_id && !next.runs.some((x) => x.key === r.key));
        const bs = v.store.baselines.filter((b) => b.import_id === im.import_id && !next.baselines.some((x) => x.key === b.key));
        added.skipped += v.store.runs.filter((r) => r.import_id === im.import_id).length - rs.length;
        if (!rs.length && !bs.length) return;
        const nid = newImportId(next);
        next.imports.push(Object.assign({}, im, { import_id: nid, source: (source + ' ← ' + im.source).slice(0, 120), imported_at: new Date().toISOString() }));
        rs.forEach((r) => next.runs.push(Object.assign({}, r, { import_id: nid })));
        bs.forEach((b) => next.baselines.push(Object.assign({}, b, { import_id: nid })));
        added.runs += rs.length; added.base += bs.length;
      });
      return commitImport(next, checks, added);
    }
    const p = parseAIReport(data);
    if (p.error) return fail(p.kind || 'required', p.error);
    runs = p.runs; baselines = p.baseline ? [p.baseline] : []; meta = p.meta;
    const next = JSON.parse(JSON.stringify(S.evals));
    const newRuns = runs.filter((r) => !next.runs.some((x) => x.key === r.key));
    const newBase = baselines.filter((b) => !next.baselines.some((x) => x.key === b.key));
    const added = { runs: newRuns.length, base: newBase.length, skipped: runs.length - newRuns.length };
    if (newRuns.length || newBase.length) {
      const nid = newImportId(next);
      next.imports.push({ import_id: nid, source: String(source).slice(0, 120), imported_at: new Date().toISOString(), generated_at: meta.generated_at, criteria_version: meta.criteria_version, dataset_count: meta.dataset_count });
      newRuns.forEach((r) => { r.import_id = nid; next.runs.push(r); });
      newBase.forEach((b) => { b.import_id = nid; next.baselines.push(b); });
    }
    return commitImport(next, checks, added, runs);
  }
  function commitImport(next, checks, added) {
    checks.slice(0, 4).forEach((c) => { c.state = 'pass'; });
    if (!added.runs && !added.base) {
      checks[4].state = 'fail'; checks[4].detail = '이미 가져온 결과입니다 (같은 회차 ' + added.skipped + '개)';
      showImportResult(checks, '새로 추가된 기록이 없습니다 — 중복 가져오기를 막았습니다', false);
      toast('이미 가져온 평가 결과입니다.', 'error');
      return;
    }
    checks[4].state = 'pass';
    checks[4].detail = '새 회차 ' + added.runs + '개' + (added.base ? ' · 규칙 기준선 ' + added.base + '개' : '') + (added.skipped ? ' · 이미 있던 회차 ' + added.skipped + '개는 건너뜀' : '');
    const prev = S.evals;
    S.evals = next;
    if (!saveEvals()) { S.evals = prev; return; }
    S.selRun = '';
    renderAll();
    showImportResult(checks, '가져왔습니다', true);
    toast('평가 결과를 가져왔습니다.');
  }
  function newImportId(store) {
    let id;
    do { id = 'I' + stamp().replace('-', '') + Math.random().toString(36).slice(2, 6).toUpperCase(); } while (store.imports.some((x) => x.import_id === id));
    return id;
  }
  async function importEvalFile(file) {
    const d = await readJsonFile(file);
    importEvalData(d, '파일: ' + String(file.name || 'JSON').slice(0, 80));
    scrollToId('db-sec-ai');
  }
  function importEvalSession() {
    const rep = window.MediApp && window.MediApp.aiReport ? window.MediApp.aiReport() : null;
    if (!rep) { toast('성능 평가 탭에서 AI 채점을 먼저 실행하세요.', 'error'); return; }
    // 같은 경로(JSON 문자열 → 해석)로 검증해 파일 가져오기와 결과가 같게 한다
    importEvalData({ data: JSON.parse(JSON.stringify(rep)) }, '현재 브라우저 탭의 성능 평가');
  }

  async function importTaskFile(file) {
    const d = await readJsonFile(file);
    if (d.error) { toast('업무 기록을 가져오지 못했습니다: ' + d.error, 'error'); return; }
    if (S.taskErr) { toast('저장된 업무 기록에 문제가 있어 가져오기를 멈췄습니다.', 'error'); return; }
    const v = parseTaskFile(d.data);
    if (v.error) { toast('업무 기록을 가져오지 못했습니다: ' + v.error, 'error'); return; }
    const ids = new Set(S.tasks.map((t) => t.id));
    const texts = new Set(S.tasks.map((t) => t.text_masked));
    const add = v.tasks.filter((t) => !ids.has(t.id) && !texts.has(t.text_masked));
    if (!add.length) { toast('새로 추가할 업무가 없습니다 (모두 이미 있는 업무 ' + v.tasks.length + '건).', 'error'); return; }
    const keep = S.tasks.slice();
    S.tasks = S.tasks.concat(add);
    if (!saveTasks()) { S.tasks = keep; return; }
    renderAll(); refreshSaveButton();
    toast('업무 ' + add.length + '건을 가져왔습니다' + (v.tasks.length - add.length ? ' (중복 ' + (v.tasks.length - add.length) + '건 제외)' : '') + '.');
  }

  // ======================= 내보내기 =======================
  function download(name, content, type) {
    const blob = new Blob([content], { type: type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function csvCell(v) {
    let x = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; // 스프레드시트 수식 실행 방지
    return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  }
  const csv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  function downloadTasksCsv() {
    if (!S.tasks.length) return;
    const head = ['업무 ID', '등록 일시', '요청 내용(개인정보 가림)', '카테고리(적용값)', '긴급도(적용값)', '원래 분류 카테고리', '원래 분류 긴급도', '관리자 수정', '분류 방식', '사용 모델', 'AI 실패로 규칙 대체', '분류 판단 근거', '담당자', '진행 상태', '추가확인 필요', '완료 일시', '최종 수정 일시'];
    const rows = S.tasks.map((t) => [t.id, fmtDT(t.created_at), t.text_masked, effCat(t), effUrg(t), t.classification.category, t.classification.urgency, t.override ? '예' : '아니오',
      t.classification.method === 'gemini' ? 'Gemini AI' : '규칙 기반', t.classification.model || '', t.classification.fallback ? '예' : '아니오', t.classification.reason,
      t.assignee, t.status, t.needs_check ? '예' : '아니오', t.completed_at ? fmtDT(t.completed_at) : '', fmtDT(t.updated_at)]);
    download('meditask-tasks-' + stamp() + '.csv', csv([head].concat(rows)), 'text/csv;charset=utf-8');
  }
  function downloadTasksJson() {
    if (!S.tasks.length) return;
    download('meditask-tasks-' + stamp() + '.json', JSON.stringify({ schema: 'meditask.tasks', version: 1, exported_at: new Date().toISOString(),
      note: '요청 문장은 개인정보를 가린 문장입니다. 이 브라우저에만 있던 기록입니다.', tasks: S.tasks }, null, 2), 'application/json;charset=utf-8');
  }
  function downloadEvalCsv() {
    const head = ['가져오기', '모델 ID', '모델 이름', '회차', '평가 일시', '평균 응답(ms)', '문장 ID', '정답 카테고리', '예측 카테고리', '정답 긴급도', '예측 긴급도', '카테고리 일치', '긴급도 일치', '완전 일치', '응답 실패', '오분류 유형'];
    const rows = [];
    const yn = (b) => (b ? '일치' : '불일치');
    S.evals.baselines.forEach((b) => b.items.forEach((i) => rows.push(['#' + importNo(b.import_id), 'rule', '규칙 기반', '기준선', '', '', i.id, i.gold_category, i.pred_category || '', i.gold_urgency, i.pred_urgency || '', yn(i.category_correct), yn(i.urgency_correct), yn(i.exact_match), i.failed ? '예' : '아니오', i.exact_match ? '정답' : errType(i)])));
    runsSorted().forEach((r) => r.items.forEach((i) => rows.push(['#' + importNo(r.import_id), r.model_id, r.display_name || '', r.run + '차', fmtDT(r.started_at), r.avg_response_ms == null ? '' : r.avg_response_ms, i.id, i.gold_category, i.pred_category || '', i.gold_urgency, i.pred_urgency || '', yn(i.category_correct), yn(i.urgency_correct), yn(i.exact_match), i.failed ? '예' : '아니오', i.exact_match ? '정답' : errType(i)])));
    download('meditask-eval-' + stamp() + '.csv', csv([head].concat(rows)), 'text/csv;charset=utf-8');
  }
  function downloadEvalJson() {
    download('meditask-eval-' + stamp() + '.json', JSON.stringify(Object.assign({ exported_at: new Date().toISOString(), note: '정답 라벨이 있는 평가 문장의 채점 기록입니다. 업무 요청 기록과 별개이며 문장 원문은 들어 있지 않습니다.' }, S.evals), null, 2), 'application/json;charset=utf-8');
  }

  // ======================= 업무 분류 화면의 '업무 저장' =======================
  function refreshSaveButton(justSaved) {
    const btn = $('save-task-btn');
    if (!btn) return;
    const r = S.ready && window.MediApp ? window.MediApp.lastResult() : null;
    const st = clear($('save-task-status'));
    const label = $('save-task-label'), ic = $('save-task-icon');
    if (!r) { btn.disabled = true; label.textContent = '업무 저장'; ic.textContent = 'bookmark_add'; return; }
    const dup = S.tasks.find((t) => t.text_masked === r.text_masked);
    const go = (id) => h('button', { type: 'button', class: 'db-link', onclick: () => { window.MediApp.showView('dashboard'); setTimeout(() => openDetail(id), 0); }, text: '대시보드에서 보기' });
    if (S.taskErr) { btn.disabled = true; append(st, '저장된 업무 기록을 읽지 못해 저장할 수 없습니다 (통합 대시보드에서 확인)'); return; }
    if (dup) {
      btn.disabled = true; label.textContent = '저장됨'; ic.textContent = 'bookmark_added';
      append(st, (justSaved ? '저장했습니다 · ' : '이미 저장된 요청입니다 · ') + dup.id + ' · ', go(dup.id));
      return;
    }
    btn.disabled = false; label.textContent = '업무 저장'; ic.textContent = 'bookmark_add';
    append(st, '저장하면 가린 문장과 분류 결과가 이 브라우저에만 보관됩니다');
  }
  function saveCurrentResult() {
    const r = window.MediApp && window.MediApp.lastResult();
    if (!r || !S.ready) return;
    if (S.tasks.some((t) => t.text_masked === r.text_masked)) { refreshSaveButton(); return; }
    const now = new Date().toISOString();
    let id;
    do { id = 'W' + stamp().slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(); } while (S.tasks.some((t) => t.id === id));
    const n = normTask({
      id: id, created_at: now, updated_at: now, text_masked: r.text_masked,
      classification: { category: r.category, urgency: r.urgency, reason: String(r.reason || '').slice(0, MAX_REASON), method: r.method, fallback: r.fallback, model: r.model, criteria_version: r.criteria_version, urgency_step: r.urgency_step },
      override: null, assignee: '', status: '접수', needs_check: false, completed_at: null
    });
    if (n.error) { toast('저장하지 못했습니다: ' + n.error, 'error'); return; }
    S.tasks.push(n.task);
    if (!saveTasks()) { S.tasks.pop(); refreshSaveButton(); return; }
    renderAll();
    refreshSaveButton(true);
  }

  // ======================= 시작 =======================
  function setup() {
    if (S.ready || !window.MediApp) return;
    const c = window.MediApp.criteria();
    if (!c || !Array.isArray(c.categories) || !c.urgency || !Array.isArray(c.urgency.levels)) return;
    S.cats = c.categories.map((x) => x.name);
    S.levels = c.urgency.levels.map((x) => x.name);
    S.top = S.levels[0];
    S.criteriaVersion = c.version;
    loadAll();
    build();
    S.ready = true;
    syncControls();
    renderAll();
    refreshSaveButton();
  }

  function init() {
    const btn = $('save-task-btn');
    if (btn) btn.addEventListener('click', saveCurrentResult);
    document.addEventListener('meditask:criteria', setup);
    document.addEventListener('meditask:classified', () => refreshSaveButton());
    document.addEventListener('meditask:result-cleared', () => refreshSaveButton());
    document.addEventListener('meditask:ai-history', () => { if (S.ready) renderAI(); });
    document.addEventListener('meditask:view', (e) => { if (S.ready && e.detail && e.detail.view === 'dashboard') renderAll(); if (e.detail && e.detail.view !== 'dashboard') closeDetail2(); });
    // 다른 탭에서 기록이 바뀌면 다시 읽는다
    window.addEventListener('storage', (e) => {
      if (!S.ready || (e.key !== KEY_TASKS && e.key !== KEY_EVALS && e.key !== null)) return;
      loadAll(); renderAll(); refreshSaveButton();
      if (S.openId) { const t = S.tasks.find((x) => x.id === S.openId); if (t) fillDetail(t); else closeDetail(); }
      toast('다른 탭에서 바뀐 기록을 반영했습니다.');
    });
    let lastMode = window.innerWidth < 768;
    window.addEventListener('resize', () => { const m = window.innerWidth < 768; if (m !== lastMode) { lastMode = m; if (S.ready && !S.view) renderTasks(); } });
    setup();
  }
  function closeDetail2() { const d = $('db-dialog'); if (d && d.open) closeDetail(); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
