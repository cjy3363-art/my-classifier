/* rules.js — 규칙 기반 분류기.
 * 업무 유형 이름·우선순위·긴급도 값은 criteria.json에서, 근거 표현과 보조 규칙은 keywords.json에서 읽는다.
 * 이 파일에는 업무 유형 이름, 긴급도 값, 키워드를 직접 적지 않는다.
 * 입력은 반드시 mask.js로 가린 문장이어야 한다. */
(function (root) {
  'use strict';

  const METHOD = 'rule';
  const lower = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

  function hits(textNS, list) {
    const out = [];
    for (const k of list || []) {
      if (textNS.includes(lower(k))) out.push(k);
    }
    return out;
  }

  function testRe(textNS, src) {
    if (!src) return null;
    const m = new RegExp(src, 'i').exec(textNS);
    return m ? m[0] : null;
  }

  // 한글 받침에 따라 조사 선택 (예: 수정 → '으로', 기타 → '로')
  function josa(word, withBatchim, without) {
    const ch = String(word).trim().slice(-1);
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return /[0-9LMNlmn]$/.test(ch) && withBatchim === '으로' ? withBatchim : without;
    const jong = code % 28;
    if (withBatchim === '으로' && jong === 8) return without; // ㄹ 받침은 '로'
    return jong ? withBatchim : without;
  }
  const quote = (list, n) => list.slice(0, n || 3).map((w) => '‘' + w + '’').join('·');

  /** criteria.json과 keywords.json이 서로 맞는 구조인지 확인한다. 문제가 있으면 오류 메시지 목록을 돌려준다. */
  function validate(criteria, keywords) {
    const errors = [];
    const names = (criteria && Array.isArray(criteria.categories) ? criteria.categories : []).map((c) => c.name);
    if (names.length === 0) errors.push('criteria.json에 업무 유형이 없습니다.');
    const order = criteria && criteria.category_priority && criteria.category_priority.order;
    if (!Array.isArray(order) || order.length !== names.length || order.some((n) => !names.includes(n))) errors.push('criteria.json 중복 분류 우선순위가 업무 유형과 맞지 않습니다.');
    const levels = (criteria && criteria.urgency && Array.isArray(criteria.urgency.levels) ? criteria.urgency.levels : []).map((l) => l.name);
    if (levels.length === 0) errors.push('criteria.json에 긴급도 단계가 없습니다.');
    const steps = criteria && criteria.urgency && criteria.urgency.decision_steps && criteria.urgency.decision_steps.steps;
    if (!Array.isArray(steps) || steps.length === 0) errors.push('criteria.json에 긴급도 판단 순서가 없습니다.');
    if (!keywords || !keywords.category || !keywords.urgency || !keywords.category_rules) {
      errors.push('keywords.json 구조가 올바르지 않습니다.');
      return errors;
    }
    names.forEach((n) => { if (!keywords.category[n]) errors.push('keywords.json에 "' + n + '" 키워드가 없습니다.'); });
    const cr = keywords.category_rules;
    const refCats = [cr.fallback_category].concat(cr.explanation_only || [], cr.topic_fallback || []);
    (cr.weak_action_yield || []).forEach((w) => refCats.push(w.category, ...(w.yields_to || [])));
    (cr.exceptions || []).forEach((e) => refCats.push(e.category, e.yields_to));
    (cr.core_task_overrides || []).forEach((o) => refCats.push(...(o.when_both || []), o.prefer));
    refCats.forEach((n) => { if (n && !names.includes(n)) errors.push('keywords.json 규칙의 업무 유형 "' + n + '"이(가) criteria.json에 없습니다.'); });
    const ku = keywords.urgency;
    (ku.step_signals || []).forEach((s) => {
      const st = (steps || []).find((x) => x.step === s.step);
      if (!st) errors.push('긴급도 ' + s.step + '단계가 criteria.json에 없습니다.');
      else if (s.step !== 5 && !levels.includes(st.if_yes)) errors.push('긴급도 ' + s.step + '단계 결과 "' + st.if_yes + '"이(가) 긴급도 단계에 없습니다.');
    });
    const s5 = ku.step5_levels || {};
    [s5.suggestion, s5.request].forEach((l) => { if (!levels.includes(l)) errors.push('keywords.json step5_levels 값 "' + l + '"이(가) 긴급도 단계에 없습니다.'); });
    return errors;
  }

  // ---------- 업무 유형 ----------
  function decideCategory(textNS, criteria, keywords) {
    const order = criteria.category_priority.order;
    const kc = keywords.category;
    const cr = keywords.category_rules;
    const found = {};
    order.forEach((name) => { found[name] = hits(textNS, (kc[name] || {}).action); });
    const notes = [];

    // 대상이 모호한 동사는 지정된 다른 작업과 함께 나오면 근거에서 뺀다.
    (cr.weak_action_yield || []).forEach((w) => {
      const weak = (kc[w.category] || {}).weak_action || [];
      const others = (w.yields_to || []).some((n) => found[n] && found[n].length);
      if (others && found[w.category].length && found[w.category].every((x) => weak.includes(x))) {
        found[w.category] = [];
        notes.push(w.reason);
      }
    });

    const explanationOnly = cr.explanation_only || [];
    let candidates = order.filter((n) => !explanationOnly.includes(n) && found[n].length > 0);
    const allCandidates = candidates.slice();

    // criteria 예외 규칙: 핵심 작업이 다른 유형이면 그 유형을 따른다.
    (cr.exceptions || []).forEach((e) => {
      if (candidates.includes(e.category) && candidates.includes(e.yields_to) && hits(textNS, e.unless_context).length === 0) {
        candidates = candidates.filter((n) => n !== e.category);
        notes.push(e.reason);
      }
    });
    // 실제 요청 작업 우선: 주제어 수준의 언급보다 산출물 요청이 많으면 그쪽을 핵심 작업으로 본다.
    (cr.core_task_overrides || []).forEach((o) => {
      const [a, b] = o.when_both;
      if (candidates.includes(a) && candidates.includes(b)) {
        const other = o.prefer === a ? b : a;
        if (o.condition === 'more_action_hits' && found[o.prefer].length > found[other].length) {
          candidates = candidates.filter((n) => n !== other);
          notes.push(o.reason);
        }
      }
    });

    let category, sentence, evidence;
    if (candidates.length) {
      category = candidates[0]; // criteria.json 우선순위 순서
      evidence = found[category];
      if (notes.length) sentence = quote(evidence) + ' 표현을 근거로 ' + category + josa(category, '으로', '로') + ' 분류했습니다(' + notes[notes.length - 1] + ').';
      else if (allCandidates.length > 1) sentence = quote(allCandidates.map((n) => found[n][0])) + ' 등 여러 작업이 섞여 있어 우선순위가 가장 앞선 ' + category + josa(category, '으로', '로') + ' 분류했습니다.';
      else sentence = quote(evidence) + ' 표현으로 보아 ' + category + ' 요청입니다.';
    } else {
      const topicCat = (cr.topic_fallback || []).find((n) => hits(textNS, (kc[n] || {}).topic).length);
      if (topicCat) {
        category = topicCat;
        evidence = hits(textNS, kc[topicCat].topic);
        sentence = '구체적인 실행 키워드는 없지만 ' + quote(evidence) + ' 관련 요청이라 ' + category + josa(category, '으로', '로') + ' 분류했습니다.';
      } else {
        category = cr.fallback_category;
        evidence = found[category] || [];
        sentence = '다른 업무 유형의 근거 표현이 없어 ' + category + josa(category, '으로', '로') + ' 분류했습니다' + (evidence.length ? '(' + quote(evidence) + ').' : '.');
      }
    }
    return { category: category, sentence: sentence, evidence: evidence, candidates: allCandidates };
  }

  // ---------- 긴급도 (criteria.urgency.decision_steps 순서) ----------
  function detectIncident(textNS, inc) {
    const priv = hits(textNS, inc.privacy_terms);
    const expo = hits(textNS, inc.exposure_terms);
    if (priv.length && expo.length) return '개인정보 노출(' + quote([priv[0], expo[0]]) + ')';
    const err = hits(textNS, inc.error_terms);
    const info = hits(textNS, inc.info_terms);
    if (err.length && info.length) return '잘못된 정보·가격(' + quote([info[0], err[0]]) + ')';
    for (const label of Object.keys(inc.patterns || {})) {
      const m = testRe(textNS, inc.patterns[label]);
      if (m) return label + '(‘' + m + '’)';
    }
    return null;
  }

  function signalValue(textNS, ku, signal) {
    if (signal === 'incident') return detectIncident(textNS, ku.incident);
    const def = ku[signal];
    if (Array.isArray(def)) { const h = hits(textNS, def); return h.length ? '‘' + h[0] + '’' : null; }
    const m = testRe(textNS, def);
    return m ? '‘' + m + '’' : null;
  }

  function decideUrgency(textNS, criteria, keywords) {
    const ku = keywords.urgency;
    const steps = criteria.urgency.decision_steps.steps;
    const signals = (ku.step_signals || []).slice().sort((a, b) => a.step - b.step);
    for (const s of signals) {
      const v = signalValue(textNS, ku, s.signal);
      if (!v) continue;
      const level = s.step === 5 ? ku.step5_levels.suggestion : steps.find((x) => x.step === s.step).if_yes;
      return { urgency: level, step: s.step, why: s.label + ': ' + v, incident: s.signal === 'incident' };
    }
    const last = signals.length ? signals[signals.length - 1].step : steps.length;
    return { urgency: ku.step5_levels.request, step: last, why: ku.step5_request_label, incident: false };
  }

  /**
   * @param {string} maskedText mask.js로 가린 문장
   * @returns {{category:string, urgency:string, reason:string, method:'rule', detail:object}}
   */
  function classify(maskedText, criteria, keywords) {
    const textNS = lower(maskedText);
    const cat = decideCategory(textNS, criteria, keywords);
    const urg = decideUrgency(textNS, criteria, keywords);

    const allowedCats = criteria.categories.map((c) => c.name);
    const allowedUrg = criteria.urgency.levels.map((l) => l.name);
    if (!allowedCats.includes(cat.category) || !allowedUrg.includes(urg.urgency)) {
      throw new Error('허용되지 않은 분류 결과');
    }

    const reason = cat.sentence + ' 긴급도는 판단 ' + urg.step + '단계(' + urg.why + ')에 해당해 ' + urg.urgency + '입니다.';
    return {
      category: cat.category,
      urgency: urg.urgency,
      reason: reason,
      method: METHOD,
      detail: { evidence: cat.evidence, candidates: cat.candidates, urgencyStep: urg.step, urgencyWhy: urg.why, incident: urg.incident }
    };
  }

  const api = { classify: classify, validate: validate, METHOD: METHOD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
