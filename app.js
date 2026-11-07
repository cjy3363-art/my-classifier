/* app.js — 화면 동작(탭, 입력, 분류, 결과 복사)과 규칙 기반 채점.
 * 개인정보 보호: 원문은 콘솔에 출력하지 않고, 외부로 전송하지 않으며, 저장하지 않는다. */
(function () {
  'use strict';

  // 이 파일에는 업무 유형·긴급도 값, 키워드, 예시 문장, 정답 데이터를 직접 적지 않는다.
  // 모두 criteria.json · keywords.json · data/answer.json에서 읽는다.
  // 아래 두 표는 화면 표시용이며, 목록에 없는 값이 와도 기본 아이콘·순서 기반 색상으로 동작한다.
  const ICON_BY_INDEX = ['add_notes', 'edit_document', 'campaign', 'monitoring', 'groups', 'more_horiz'];
  const URGENCY_CLASS_BY_INDEX = ['u-high', 'u-mid', 'u-low'];
  const METHOD_LABEL = { rule: '규칙 기반' };

  const $ = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  const state = {
    criteria: null,
    keywords: null,
    answers: null,
    lastResult: null,
    evalRows: null,
    filter: 'all',
    classifying: false,
    evaluating: false
  };

  // ======================= 공통: 데이터 로드 =======================
  async function fetchJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(path + ' 응답 오류 (' + res.status + ')');
    try { return await res.json(); }
    catch (e) { throw new Error(path + ' JSON 형식 오류'); }
  }

  async function loadClassifierData() {
    setClassifyState('loading-data');
    setCriteriaViewState('loading');
    try {
      // 분류 기준 화면은 criteria.json만 있으면 그릴 수 있으므로 두 파일의 성공·실패를 따로 판정한다.
      const [cr, kw] = await Promise.allSettled([fetchJson('criteria.json'), fetchJson('keywords.json')]);
      if (cr.status === 'fulfilled') {
        try { renderCriteriaView(cr.value); } catch (e) { renderCriteriaError(new Error('criteria.json 구조를 해석하지 못했습니다')); }
      } else renderCriteriaError(cr.reason);
      if (cr.status === 'rejected') throw cr.reason;
      if (kw.status === 'rejected') throw kw.reason;
      const criteria = cr.value, keywords = kw.value;
      const problems = window.MediRules.validate(criteria, keywords);
      if (problems.length) throw new Error(problems.join(' '));
      state.criteria = criteria;
      state.keywords = keywords;
      $('footer-version').textContent = 'criteria v' + criteria.version;
      renderExamples();
      $('classify-data-error').hidden = true;
      setClassifyState(currentText().trim() ? 'typing' : 'idle');
    } catch (err) {
      state.criteria = null;
      state.keywords = null;
      $('classify-data-error-msg').textContent = '분류 기능을 중단했습니다. 원인: ' + err.message;
      $('classify-data-error').hidden = false;
      setClassifyState('data-error');
      console.error('[MEDI TASK] 분류 기준 로드 실패:', err.message);
    }
    refreshEvalAvailability();
  }

  async function loadAnswers() {
    setEvalStatus('loading');
    try {
      const data = await fetchJson('data/answer.json');
      if (!Array.isArray(data) || data.length === 0) throw new Error('answer.json에 평가 문장이 없습니다.');
      state.answers = data;
      $('eval-total-label').textContent = data.length;
      $('error-empty-sub').textContent = '검증셋 ' + data.length + '문항 대기 중';
      $('eval-error').hidden = true;
    } catch (err) {
      state.answers = null;
      $('eval-error-msg').textContent = '평가 데이터를 불러오지 못했습니다. 원인: ' + err.message;
      $('eval-error').hidden = false;
      console.error('[MEDI TASK] 평가 데이터 로드 실패:', err.message);
    }
    refreshEvalAvailability();
  }

  // ======================= 탭 =======================
  function viewNames() { return Array.from(document.querySelectorAll('.tab')).map((t) => t.dataset.view); }

  function showView(name) {
    if (!viewNames().includes(name)) name = 'classify';
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    viewNames().forEach((v) => { $('view-' + v).hidden = v !== name; });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
  }

  // ======================= 업무 분류 =======================
  const input = () => $('task-input');
  const currentText = () => input().value;

  /** 상태: loading-data | data-error | idle(입력 전) | typing(입력 중) | loading(분류 중) | done(완료) | error */
  function setClassifyState(s) {
    $('view-classify').dataset.state = s;
    const hasText = currentText().trim().length > 0;
    const dataReady = !!(state.criteria && state.keywords);
    const busy = s === 'loading';

    const btn = $('classify-btn');
    btn.disabled = busy || !dataReady || !hasText;
    btn.classList.toggle('is-busy', busy);
    $('classify-btn-icon').textContent = busy ? 'progress_activity' : 'psychology';
    $('classify-btn-icon').classList.toggle('spin', busy);
    $('classify-btn-label').textContent = busy ? '업무를 분류하고 있습니다...' : (s === 'data-error' ? '분류 기준 오류로 사용할 수 없음' : '업무 분류하기');

    input().disabled = busy || s === 'data-error' || s === 'loading-data';
    $('reset-btn').disabled = busy;
    document.querySelectorAll('.chip').forEach((c) => { c.disabled = busy || !dataReady; });

    $('classify-loading').hidden = s !== 'loading';
    $('classify-result').hidden = s !== 'done';
    $('classify-error').hidden = s !== 'error';

    const label = $('input-state-label');
    const labels = { 'loading-data': '기준 불러오는 중', 'data-error': '사용 불가', idle: '입력 전', typing: '입력 중', loading: '분류 중', done: '분류 완료', error: '오류' };
    label.textContent = labels[s] || '';
    label.classList.toggle('is-typing', s === 'typing' || s === 'loading');
  }

  function onInputChanged() {
    const el = input();
    const max = el.maxLength > 0 ? el.maxLength : 500; // 최대 글자 수는 index.html의 maxlength 한 곳에서 관리
    if (el.value.length > max) el.value = el.value.slice(0, max);
    $('char-count').textContent = el.value.length + ' / ' + max + '자';
    // 입력이 바뀌면 이전 결과는 즉시 숨긴다(새 입력의 결과로 오해하지 않도록).
    state.lastResult = null;
    if (!state.criteria) return setClassifyState($('view-classify').dataset.state === 'data-error' ? 'data-error' : 'loading-data');
    setClassifyState(el.value.trim() ? 'typing' : 'idle');
  }

  function setStep(name, status, sub) {
    const li = document.querySelector('#classify-steps li[data-step="' + name + '"]');
    if (!li) return;
    li.classList.toggle('is-active', status === 'active');
    li.classList.toggle('is-done', status === 'done');
    li.querySelector('.step-sub').textContent = sub;
  }

  async function runClassify() {
    const raw = currentText();
    if (!raw.trim() || state.classifying || !state.criteria) return;
    state.classifying = true;
    ['mask', 'category', 'urgency'].forEach((n) => setStep(n, 'wait', '대기 중'));
    setClassifyState('loading');
    try {
      setStep('mask', 'active', '가리는 중...');
      await nextFrame();
      const masked = window.MediMask.maskText(raw);
      setStep('mask', 'done', '완료 · 가림 ' + masked.total + '건');

      setStep('category', 'active', '판단 중...');
      await nextFrame();
      // 분류기에는 가림 처리된 문장만 전달한다.
      const result = window.MediRules.classify(masked.masked, state.criteria, state.keywords);
      setStep('category', 'done', '완료 · ' + result.category);

      setStep('urgency', 'active', '판단 중...');
      await nextFrame();
      setStep('urgency', 'done', '완료 · ' + result.urgency + ' (' + result.detail.urgencyStep + '단계)');

      if (currentText() !== raw) { setClassifyState(currentText().trim() ? 'typing' : 'idle'); return; }
      state.lastResult = { masked: masked, result: result };
      renderResult(state.lastResult);
      setClassifyState('done');
    } catch (err) {
      $('classify-error-msg').textContent = '규칙 기반 분류 중 오류가 발생했습니다: ' + err.message;
      setClassifyState('error');
      console.error('[MEDI TASK] 분류 오류:', err.message);
    } finally {
      state.classifying = false;
    }
  }

  function renderResult(r) {
    const res = r.result;
    $('result-category').textContent = res.category;
    const catIdx = state.criteria.categories.findIndex((c) => c.name === res.category);
    $('result-category-icon').textContent = ICON_BY_INDEX[catIdx] || 'category';
    $('result-urgency').textContent = res.urgency;
    $('result-urgency-step').textContent = '긴급도 판단 ' + res.detail.urgencyStep + '단계';
    const tile = $('urgency-tile');
    tile.classList.remove(...URGENCY_CLASS_BY_INDEX);
    const urgIdx = state.criteria.urgency.levels.findIndex((l) => l.name === res.urgency);
    if (URGENCY_CLASS_BY_INDEX[urgIdx]) tile.classList.add(URGENCY_CLASS_BY_INDEX[urgIdx]);
    $('result-reason').textContent = res.reason;
    $('result-masked').textContent = r.masked.masked;
    const c = r.masked.counts;
    const parts = Object.keys(c).filter((k) => c[k] > 0).map((k) => k + ' ' + c[k]);
    $('result-mask-badge').textContent = r.masked.total ? '가림 ' + r.masked.total + '건' : '가릴 정보 없음';
    $('result-mask-badge').title = parts.join(', ');
    $('result-method').textContent = methodText(res.method);
    resetCopyButton();
  }

  function methodText(method) {
    return (METHOD_LABEL[method] || method) + ' (method: ' + method + ', criteria v' + state.criteria.version + ')';
  }

  function resetAll() {
    input().value = '';
    state.lastResult = null;
    $('classify-error-msg').textContent = '';
    $('copy-status').textContent = '';
    ['mask', 'category', 'urgency'].forEach((n) => setStep(n, 'wait', '대기 중'));
    onInputChanged();
    input().focus();
  }

  function renderExamples() {
    const box = $('example-chips');
    const items = (state.keywords.ui_examples && state.keywords.ui_examples.items) || [];
    box.textContent = '';
    items.forEach((ex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = '🏷️ ' + ex.label;
      b.setAttribute('aria-label', '예시 문장 넣기: ' + ex.label);
      b.addEventListener('click', () => { input().value = ex.text; onInputChanged(); input().focus(); });
      box.appendChild(b);
    });
    $('examples-block').hidden = items.length === 0;
    setClassifyState($('view-classify').dataset.state);
  }

  // ---------- 결과 복사 ----------
  let copyTimer = null;
  function resetCopyButton() {
    clearTimeout(copyTimer);
    $('copy-icon').textContent = 'content_copy';
    $('copy-label').textContent = '결과 복사';
  }
  async function copyResult() {
    const r = state.lastResult;
    if (!r) return;
    const text = [
      '[MEDI TASK 분류 결과]',
      '- 업무 유형: ' + r.result.category,
      '- 긴급도: ' + r.result.urgency,
      '- 분류 이유: ' + r.result.reason,
      '- 요청(개인정보 가림): ' + r.masked.masked,
      '- 분류 방식: ' + methodText(r.result.method)
    ].join('\n');
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
    } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
    }
    $('copy-icon').textContent = ok ? 'check' : 'error';
    $('copy-label').textContent = ok ? '복사됨!' : '복사 실패';
    $('copy-status').textContent = ok ? '분류 결과를 클립보드에 복사했습니다.' : '복사하지 못했습니다. 결과 내용을 직접 선택해 복사해 주세요.';
    $('copy-status').classList.toggle('text-error', !ok);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(resetCopyButton, 1800);
  }

  // ======================= 성능 평가 =======================
  function setEvalStatus(s) {
    const pill = $('eval-status');
    const map = {
      loading: ['pill-soft', '불러오는 중'], ready: ['pill-ok', '준비 완료'], running: ['pill-busy', '채점 중'],
      done: ['pill-ok', '채점 완료'], error: ['pill-error', '오류']
    };
    const m = map[s] || map.ready;
    pill.className = 'pill ' + m[0];
    $('eval-status-text').textContent = m[1];
    $('view-evaluate').dataset.state = s;
  }

  function refreshEvalAvailability() {
    if (state.evaluating) return;
    const btn = $('rule-eval-btn');
    const ready = !!(state.answers && state.criteria && state.keywords);
    btn.disabled = !ready;
    if (!state.answers) { setEvalStatus($('eval-error').hidden ? 'loading' : 'error'); return; }
    if (!state.criteria || !state.keywords) {
      setEvalStatus('error');
      $('eval-error-msg').textContent = '분류 기준(criteria.json·keywords.json)을 불러오지 못해 채점할 수 없습니다.';
      $('eval-error').hidden = false;
      $('eval-retry').hidden = true;
      return;
    }
    $('eval-retry').hidden = false;
    // answer.json 필드 이름은 keywords.json의 evaluation.fields에서 읽는다.
    const f = evalFields();
    const bad = f ? state.answers.filter((r) => !r || typeof r[f.text] !== 'string' || typeof r[f.category] !== 'string' || typeof r[f.urgency] !== 'string') : state.answers;
    if (!f || bad.length) {
      btn.disabled = true;
      setEvalStatus('error');
      $('eval-error-msg').textContent = !f ? 'keywords.json에 평가 필드 설정(evaluation.fields)이 없습니다.' : 'answer.json 항목 ' + bad.length + '개에 문장·업무 유형·긴급도 값이 없습니다.';
      $('eval-error').hidden = false;
      return;
    }
    $('eval-error').hidden = true;
    setEvalStatus(state.evalRows ? 'done' : 'ready');
  }

  function evalFields() {
    const e = state.keywords && state.keywords.evaluation;
    return e && e.fields && e.fields.text && e.fields.category && e.fields.urgency ? e.fields : null;
  }

  function incidentFieldOf(rows) {
    const list = (state.keywords.evaluation && state.keywords.evaluation.incident_flag_fields) || [];
    for (const f of list) {
      if (rows.every((r) => typeof r[f] === 'boolean')) return f;
    }
    return null;
  }

  async function runEvaluation() {
    if (state.evaluating || !state.answers || !state.criteria || !evalFields()) return;
    state.evaluating = true;
    const answers = state.answers;
    const F = evalFields();
    const total = answers.length;
    const btn = $('rule-eval-btn');
    btn.disabled = true; btn.classList.add('is-busy');
    $('rule-eval-icon').textContent = 'progress_activity'; $('rule-eval-icon').classList.add('spin');
    $('rule-eval-label').textContent = '규칙 검증 채점 중...';
    setEvalStatus('running');
    $('eval-progress').hidden = false;
    $('eval-error').hidden = true;
    setMetricsPending();

    const rows = [];
    let failures = 0;
    try {
      for (let i = 0; i < total; i++) {
        const a = answers[i];
        let pred = null;
        let failed = false;
        // 평가도 화면 분류와 같은 경로: 마스킹 → 마스킹된 문장만 분류
        const masked = window.MediMask.maskText(a[F.text]);
        try {
          pred = window.MediRules.classify(masked.masked, state.criteria, state.keywords);
        } catch (e) { failed = true; failures++; }
        const goldCat = a[F.category], goldUrg = a[F.urgency];
        const catOk = !failed && pred.category === goldCat;
        const urgOk = !failed && pred.urgency === goldUrg;
        const rowId = (F.id && a[F.id]) || ('#' + (i + 1));
        rows.push({
          id: rowId, text: masked.masked, goldCat: goldCat, goldUrg: goldUrg,
          predCat: failed ? '(실패)' : pred.category, predUrg: failed ? '(실패)' : pred.urgency,
          reason: failed ? '분류 실패' : pred.reason, catOk: catOk, urgOk: urgOk, failed: failed, raw: a
        });
        updateProgress(i + 1, total, rowId);
        await nextFrame();
      }
      state.evalRows = rows;
      renderEvaluation(rows, failures);
      setEvalStatus('done');
    } catch (err) {
      $('eval-error-msg').textContent = '채점 중 오류가 발생했습니다: ' + err.message;
      $('eval-error').hidden = false;
      setEvalStatus('error');
      console.error('[MEDI TASK] 채점 오류:', err.message);
    } finally {
      state.evaluating = false;
      $('eval-progress').hidden = true;
      btn.classList.remove('is-busy');
      $('rule-eval-icon').textContent = state.evalRows ? 'replay' : 'rule_settings';
      $('rule-eval-icon').classList.remove('spin');
      $('rule-eval-label').textContent = state.evalRows ? '규칙으로 다시 채점' : '규칙으로 채점';
      btn.disabled = !(state.answers && state.criteria);
    }
  }

  function updateProgress(done, total, id) {
    const pct = Math.round((done / total) * 1000) / 10;
    $('eval-progress-pct').textContent = pct.toFixed(1) + '%';
    $('eval-progress-text').textContent = done + ' / ' + total + ' 문장';
    $('eval-progress-current').textContent = id ? '방금 채점: ' + id : '';
    $('eval-progress-bar').style.width = pct + '%';
  }

  function setMetricsPending() {
    $('metrics-state').textContent = '채점 중';
    ['m-cat', 'm-urg', 'm-both', 'm-crit'].forEach((id) => { $(id).textContent = '…'; $(id).className = $(id).className.replace(/\s?(has-value|is-note)/g, ''); });
  }

  const pctText = (n, total) => (total ? (Math.round((n / total) * 1000) / 10).toFixed(1) : '0.0') + '%';

  function setMetric(id, value, sub, cls) {
    const el = $(id);
    el.textContent = value;
    el.classList.remove('has-value', 'is-note');
    el.classList.add(cls || 'has-value');
    const s = $(id + '-sub');
    s.textContent = sub;
    s.classList.toggle('is-note', cls === 'is-note');
  }

  function renderEvaluation(rows, failures) {
    const total = rows.length;
    const cat = rows.filter((r) => r.catOk).length;
    const urg = rows.filter((r) => r.urgOk).length;
    const both = rows.filter((r) => r.catOk && r.urgOk).length;
    const wrong = total - both;

    setMetric('m-cat', pctText(cat, total), cat + ' / ' + total + ' 일치');
    setMetric('m-urg', pctText(urg, total), urg + ' / ' + total + ' 일치');
    setMetric('m-both', pctText(both, total), both + ' / ' + total + ' 일치');

    const field = incidentFieldOf(rows.map((r) => r.raw));
    let critText;
    if (field) {
      const incidents = rows.filter((r) => r.raw[field] === true);
      const top = state.criteria.urgency.levels[0].name; // criteria.json의 가장 높은 긴급도
      const missed = incidents.filter((r) => r.predUrg !== top).length;
      critText = missed + '건';
      setMetric('m-crit', critText, '사고성 정답 ' + incidents.length + '건 중 높음 누락');
    } else {
      critText = '측정 기준 확인 필요';
      setMetric('m-crit', critText, 'answer.json에 사고 여부 표시가 없음', 'is-note');
    }
    $('m-wrong').textContent = wrong + '건';
    $('m-total').textContent = total + '건';
    $('metrics-state').textContent = '채점 완료 · ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const setCell = (id, txt, cls) => { const el = $(id); el.textContent = txt; el.className = cls || 'has-value'; };
    setCell('c-cat', pctText(cat, total));
    setCell('c-urg', pctText(urg, total));
    setCell('c-both', pctText(both, total));
    setCell('c-crit', field ? critText : '기준 확인 필요', field ? 'has-value' : 'is-note');
    setCell('c-fail', failures + '건');
    $('compare-state').textContent = '규칙 채점 완료';

    // 필터 수
    const counts = {
      all: rows.filter((r) => !(r.catOk && r.urgOk)).length,
      category: rows.filter((r) => !r.catOk).length,
      urgency: rows.filter((r) => !r.urgOk).length,
      both: rows.filter((r) => !r.catOk && !r.urgOk).length
    };
    $('f-all').textContent = counts.all;
    $('f-category').textContent = counts.category;
    $('f-urgency').textContent = counts.urgency;
    $('f-both').textContent = counts.both;
    document.querySelectorAll('.fchip').forEach((b) => { b.disabled = false; });
    $('csv-btn').disabled = false;
    const badge = $('error-count-badge');
    badge.hidden = false;
    badge.textContent = counts.all + '건';
    renderErrorList();
  }

  function filteredRows() {
    const rows = state.evalRows || [];
    switch (state.filter) {
      case 'category': return rows.filter((r) => !r.catOk);
      case 'urgency': return rows.filter((r) => !r.urgOk);
      case 'both': return rows.filter((r) => !r.catOk && !r.urgOk);
      default: return rows.filter((r) => !(r.catOk && r.urgOk));
    }
  }

  function pairHtml(container, catText, urgText, catDiff, urgDiff) {
    container.textContent = '';
    const a = document.createElement('span');
    a.textContent = catText; if (catDiff) a.className = 'diff';
    const sep = document.createTextNode(' / ');
    const b = document.createElement('span');
    b.textContent = urgText; if (urgDiff) b.className = 'diff';
    container.append(a, sep, b);
  }

  function renderErrorList() {
    const list = $('error-list');
    list.textContent = '';
    if (!state.evalRows) return;
    const rows = filteredRows();
    const empty = $('error-empty');
    if (rows.length === 0) {
      empty.hidden = false;
      $('error-empty-title').textContent = '이 필터에 해당하는 오분류가 없습니다';
      $('error-empty-sub').textContent = '전체 ' + state.evalRows.length + '문항 채점 완료';
      return;
    }
    empty.hidden = true;
    const tpl = $('error-item-tpl');
    rows.forEach((r) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.item-id').textContent = r.id;
      node.querySelector('.item-type').textContent = errorType(r);
      node.querySelector('.quote').textContent = '“' + r.text + '”';
      pairHtml(node.querySelector('.gold-value'), r.goldCat, r.goldUrg, !r.catOk, !r.urgOk);
      pairHtml(node.querySelector('.pred-value'), r.predCat, r.predUrg, !r.catOk, !r.urgOk);
      node.querySelector('.item-reason').textContent = '규칙 근거 · ' + r.reason;
      list.appendChild(node);
    });
  }

  function errorType(r) {
    if (r.failed) return '분류 실패';
    if (r.catOk && r.urgOk) return '정답';
    if (!r.catOk && !r.urgOk) return '모두 오류';
    return !r.catOk ? '업무 유형 오류' : '긴급도 오류';
  }

  function setFilter(f) {
    state.filter = f;
    document.querySelectorAll('.fchip').forEach((b) => {
      const on = b.dataset.filter === f;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderErrorList();
  }

  // ---------- CSV (필터와 무관하게 전체 결과, UTF-8 BOM) ----------
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv() {
    const rows = state.evalRows;
    if (!rows) return;
    // 9개 열 (r.text는 마스킹 처리된 문장)
    const header = ['문장 ID', '업무 요청 문장(마스킹 처리)', '사람 정답 업무 유형', '규칙 판정 업무 유형', '사람 정답 긴급도', '규칙 판정 긴급도', '업무 유형 일치 여부', '긴급도 일치 여부', '오류 유형'];
    const lines = [header.map(csvCell).join(',')];
    rows.forEach((r) => {
      lines.push([r.id, r.text, r.goldCat, r.predCat, r.goldUrg, r.predUrg,
        r.catOk ? '일치' : '불일치', r.urgOk ? '일치' : '불일치', errorType(r)].map(csvCell).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = 'medi-task-rule-eval-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ======================= 분류 기준 (읽기 전용) =======================
  // criteria.json의 내용만 화면에 옮긴다. JSON에 없는 항목은 만들지 않고 생략한다.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const maskShow = (t) => window.MediMask.maskText(String(t)).masked; // 예시 문장은 마스킹 후 표시
  const nonEmpty = (a) => Array.isArray(a) && a.length > 0;

  function setCriteriaViewState(s) {
    $('view-criteria').dataset.state = s;
    $('criteria-loading').hidden = s !== 'loading';
    $('criteria-error').hidden = s !== 'error';
    $('criteria-empty').hidden = s !== 'empty';
    $('criteria-content').hidden = s !== 'ready';
  }

  function renderCriteriaError(err) {
    $('criteria-error-msg').textContent = '기준 화면을 표시할 수 없습니다. 원인: ' + (err && err.message ? err.message : err);
    setCriteriaViewState('error');
  }

  let accSeq = 0;
  /** 펼치기/접기 카드. 버튼에 aria-expanded, 본문에 id를 연결한다. */
  function accordion(title, badge, fillBody, opts) {
    opts = opts || {};
    const card = el('div', 'card acc' + (opts.cls ? ' ' + opts.cls : ''));
    const id = 'acc-' + (++accSeq);
    const btn = el('button', 'acc-btn');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    const left = el('span', 'acc-title');
    if (opts.lead) left.appendChild(opts.lead);
    const tw = el('span', 'acc-title-wrap');
    tw.appendChild(el('span', 'acc-title-text', title));
    if (opts.sub) tw.appendChild(el('span', 'acc-sub', opts.sub));
    left.appendChild(tw);
    btn.appendChild(left);
    if (badge) btn.appendChild(el('span', 'pill pill-soft acc-badge', badge));
    btn.appendChild(el('span', 'icon icon-18 acc-chev', 'expand_more'));
    const body = el('div', 'acc-body');
    body.id = id;
    body.hidden = true;
    fillBody(body);
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      body.hidden = !open;
    });
    card.append(btn, body);
    return card;
  }

  function field(parent, label, content) {
    if (content == null || content === '' || (Array.isArray(content) && !content.length)) return;
    const box = el('div', 'kv');
    box.appendChild(el('span', 'kv-label', label));
    if (Array.isArray(content)) {
      const ul = el('ul', 'kv-list');
      content.forEach((c) => ul.appendChild(el('li', null, c)));
      box.appendChild(ul);
    } else if (content instanceof Node) box.appendChild(content);
    else box.appendChild(el('p', 'body-sm', content));
    parent.appendChild(box);
  }

  function tagList(words) {
    const wrap = el('div', 'tag-list');
    words.forEach((w) => wrap.appendChild(el('span', 'tag-static', w)));
    return wrap;
  }

  /** 사례 카드: JSON에 있는 항목(업무 유형·긴급도·근거)만 표시 */
  function caseCard(c) {
    const card = el('div', 'case');
    card.appendChild(el('p', 'quote', '“' + maskShow(c.text) + '”'));
    const meta = el('div', 'case-meta');
    if (c.category) { const b = el('span', 'pill pill-busy'); b.textContent = '업무 유형 · ' + c.category; meta.appendChild(b); }
    if (c.urgency) { const b = el('span', 'pill urg-pill ' + urgencyClass(c.urgency)); b.textContent = '긴급도 · ' + c.urgency; meta.appendChild(b); }
    if (meta.children.length) card.appendChild(meta);
    if (c.reason) card.appendChild(el('p', 'label-xs muted', '판단 근거: ' + c.reason));
    return card;
  }

  let critLevels = [];
  function urgencyClass(name) {
    const i = critLevels.indexOf(name);
    return URGENCY_CLASS_BY_INDEX[i] || '';
  }

  function renderCriteriaView(c) {
    const cats = (c && Array.isArray(c.categories)) ? c.categories : [];
    const urg = c && c.urgency;
    const levels = urg && Array.isArray(urg.levels) ? urg.levels : [];
    if (!cats.length && !levels.length) { setCriteriaViewState('empty'); return; }
    critLevels = levels.map((l) => l.name);
    accSeq = 0;
    const prio = c.category_priority || {};
    const order = Array.isArray(prio.order) ? prio.order : [];
    const rules = (urg && Array.isArray(urg.rules)) ? urg.rules : [];
    const ds = urg && urg.decision_steps;
    const ud = urg && urg.unclear_deadline;
    // "제목. 설명" 형태의 규칙은 제목만 기본 화면에 쓰고, 전문은 상세 영역에 둔다.
    const ruleTitle = (r) => { const cut = r.indexOf('. '); return cut > 0 && cut < r.length - 2 ? r.slice(0, cut + 1) : r; };

    // ① 업무 유형: 이름 + 정의 한 줄(접힘), 펼치면 정의 전체·키워드·포함 업무·주의점
    $('cr-cat-count').textContent = cats.length + '개';
    const catBox = $('cr-categories');
    catBox.textContent = '';
    cats.forEach((cat, i) => {
      const lead = el('span', 'tile-icon'); lead.appendChild(el('span', 'icon icon-16', ICON_BY_INDEX[i] || 'category'));
      const rank = order.indexOf(cat.name);
      catBox.appendChild(accordion(cat.name, rank >= 0 ? '순위 ' + (rank + 1) : null, (b) => {
        if (nonEmpty(cat.keywords)) field(b, '판단 키워드', tagList(cat.keywords));
        field(b, '포함 업무', cat.includes);
        field(b, '구분 주의', cat.exception);
      }, { lead: lead, sub: cat.definition, cls: 'acc-compact' }));
    });

    // ② 긴급도: 색상 배지 + 핵심 기준 1개(criteria 첫 항목), 판단 순서는 접힌 영역
    $('cr-urg-count').textContent = levels.length + '단계';
    const lvBox = $('cr-levels');
    lvBox.textContent = '';
    levels.forEach((lv) => {
      const row = el('div', 'level-row');
      row.appendChild(el('span', 'pill urg-pill ' + urgencyClass(lv.name), lv.name));
      const txt = el('div', 'level-text');
      if (nonEmpty(lv.criteria)) txt.appendChild(el('p', 'body-sm', lv.criteria[0]));
      if (nonEmpty(lv.criteria) && lv.criteria.length > 1) txt.appendChild(el('p', 'label-xs muted', '외 ' + (lv.criteria.length - 1) + '개 기준 · 전체 기준에서 확인'));
      row.appendChild(txt);
      lvBox.appendChild(row);
    });
    const stepSlot = $('cr-steps-slot');
    stepSlot.textContent = '';
    const steps = (ds && Array.isArray(ds.steps)) ? ds.steps : [];
    if (steps.length) {
      stepSlot.appendChild(accordion('판단 순서 자세히 보기', steps.length + '단계', (b) => {
        if (ds.rule) b.appendChild(el('p', 'label-xs muted', ds.rule));
        const flow = el('ol', 'flow');
        flow.id = 'cr-steps';
        steps.forEach((s) => {
          const li = el('li', 'flow-step');
          li.appendChild(el('span', 'flow-num', String(s.step)));
          const body = el('div', 'flow-body');
          body.appendChild(el('p', 'body-sm flow-check', s.check));
          body.appendChild(el('p', 'label-xs flow-result', '그렇다 → ' + s.if_yes));
          if (s.note) body.appendChild(el('p', 'label-xs muted', s.note));
          li.appendChild(body);
          flow.appendChild(li);
        });
        b.appendChild(flow);
      }, { lead: iconLead('account_tree') }));
    }

    // ③ 중복 분류 우선순위: 순서 흐름 + 규칙 한 줄 + 핵심 작업 원칙
    const pl = $('cr-priority');
    pl.textContent = '';
    order.forEach((name, i) => {
      const li = el('li', 'prio-chip' + (i === 0 ? ' is-first' : ''));
      li.append(el('span', 'prio-n', String(i + 1)), el('span', null, name));
      pl.appendChild(li);
    });
    $('cr-priority-rule').textContent = prio.rule || '';
    $('cr-core-principle').textContent = prio.core_task_principle || '';

    // ④ 예외 및 주의사항: 판단 규칙 제목만 기본 표시
    const cl = $('cr-cautions');
    cl.textContent = '';
    rules.forEach((r) => {
      const li = el('li', 'caution');
      li.append(el('span', 'icon icon-16 text-secondary', 'check_circle'), el('span', 'body-sm', ruleTitle(r)));
      cl.appendChild(li);
    });

    // 전체 기준 자세히 보기: 나머지 기준·예외·경계 사례를 모두 보존
    const full = $('cr-full-slot');
    full.textContent = '';
    const exCats = cats.filter((x) => x.exception || nonEmpty(x.exception_examples));
    const caseCount = exCats.reduce((n, x) => n + (x.exception_examples || []).length, 0) + (prio.examples || []).length + ((urg && urg.boundary_cases) || []).length;
    full.appendChild(accordion('전체 기준 자세히 보기', '사례 ' + caseCount + '건', (b) => {
      b.appendChild(accordion('긴급도 단계별 전체 기준', levels.length + '단계', (bb) => {
        levels.forEach((lv) => {
          const card = el('div', 'case');
          card.appendChild(el('span', 'pill urg-pill ' + urgencyClass(lv.name), lv.name));
          if (nonEmpty(lv.criteria)) { const ul = el('ul', 'kv-list'); lv.criteria.forEach((t) => ul.appendChild(el('li', null, t))); card.appendChild(ul); }
          if (nonEmpty(lv.examples)) card.appendChild(tagList(lv.examples));
          bb.appendChild(card);
        });
      }, { cls: 'acc-nested' }));
      if (rules.length) {
        b.appendChild(accordion('긴급도 판단 규칙 전문', rules.length + '개', (bb) => {
          const ol = el('ol', 'kv-list'); rules.forEach((r) => ol.appendChild(el('li', null, r))); bb.appendChild(ol);
        }, { cls: 'acc-nested' }));
      }
      if (ud && (ud.rule || ud.future_recommendation)) {
        b.appendChild(accordion('기준 시점이 불명확한 마감', null, (bb) => {
          if (ud.rule) { const d = el('div', 'scope-card scope-now'); d.append(el('span', 'pill pill-ok', '현재 적용'), el('p', 'body-sm', ud.rule)); bb.appendChild(d); }
          if (ud.future_recommendation) { const d = el('div', 'scope-card scope-future'); d.append(el('span', 'pill pill-soft', '향후 개선 권고 · 현재 미적용'), el('p', 'body-sm', ud.future_recommendation)); bb.appendChild(d); }
        }, { cls: 'acc-nested' }));
      }
      exCats.forEach((x) => {
        b.appendChild(accordion(x.name + ' 예외', nonEmpty(x.exception_examples) ? x.exception_examples.length + '건' : null, (bb) => {
          if (x.exception) bb.appendChild(el('p', 'body-sm muted', x.exception));
          (x.exception_examples || []).forEach((e) => bb.appendChild(caseCard(e)));
        }, { cls: 'acc-nested' }));
      });
      if (nonEmpty(prio.examples)) {
        b.appendChild(accordion('업무 유형이 겹치는 요청', prio.examples.length + '건', (bb) => {
          prio.examples.forEach((e) => bb.appendChild(caseCard(e)));
        }, { cls: 'acc-nested' }));
      }
      if (urg && nonEmpty(urg.boundary_cases)) {
        b.appendChild(accordion('긴급도 경계 사례', urg.boundary_cases.length + '건', (bb) => {
          urg.boundary_cases.forEach((e) => bb.appendChild(caseCard(e)));
        }, { cls: 'acc-nested' }));
      }
    }, { lead: iconLead('menu_book') }));

    // 기준 버전 · 작성자
    const sc = c.current_version_scope;
    const parts = [];
    if (c.version != null) parts.push('기준 v' + c.version);
    if (c.owner) parts.push(c.owner);
    if (sc && typeof sc.receipt_datetime_input === 'boolean') parts.push('접수 일시 입력 ' + (sc.receipt_datetime_input ? '적용' : '미적용'));
    $('cr-version').textContent = parts.join(' · ');

    setCriteriaViewState('ready');
  }

  function iconLead(name) { const s = el('span', 'tile-icon'); s.appendChild(el('span', 'icon icon-16', name)); return s; }

  // ======================= 이벤트 연결 =======================
  function bind() {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => showView(t.dataset.view));
      // 탭 목록 키보드 조작: ←/→ 이동, Home/End
      t.addEventListener('keydown', (e) => {
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j === null) return;
        e.preventDefault();
        showView(tabs[j].dataset.view);
        tabs[j].focus();
      });
    });
    input().addEventListener('input', onInputChanged);
    input().addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('classify-btn').disabled) runClassify();
    });
    $('classify-btn').addEventListener('click', runClassify);
    $('reset-btn').addEventListener('click', resetAll);
    $('copy-btn').addEventListener('click', copyResult);
    $('classify-data-retry').addEventListener('click', loadClassifierData);
    $('rule-eval-btn').addEventListener('click', runEvaluation);
    $('eval-retry').addEventListener('click', () => { loadAnswers(); if (!state.criteria) loadClassifierData(); });
    document.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
    $('csv-btn').addEventListener('click', downloadCsv);
    $('criteria-retry').addEventListener('click', loadClassifierData);
  }

  function init() {
    if (!window.MediMask || !window.MediRules) {
      document.body.insertAdjacentHTML('afterbegin', '<p style="padding:1rem;color:#ba1a1a">mask.js 또는 rules.js를 불러오지 못했습니다.</p>');
      return;
    }
    bind();
    showView(location.hash ? location.hash.slice(1) : 'classify');
    onInputChanged();
    loadClassifierData();
    loadAnswers();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
