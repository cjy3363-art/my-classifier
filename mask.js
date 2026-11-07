/* mask.js — 이름·전화번호·사번을 브라우저에서 가린다.
 * 원문은 어디에도 저장하거나 출력하지 않고, 가린 문장과 가린 건수만 돌려준다. */
(function (root) {
  'use strict';

  // 흔한 한국 성씨 (한 글자). 직함·일반 명사와 겹치는 경우는 아래 STOP_WORDS로 거른다.
  const SURNAMES = '김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경';
  const TITLES = '님|씨|환자분|환자|원장님|원장|실장님|실장|팀장님|팀장|과장님|과장|대리님|대리|주임님|주임|사원|선생님|매니저님|매니저|간호사|고객님';
  const STOP_WORDS = new Set([
    '원장', '실장', '팀장', '과장', '부장', '차장', '대리', '주임', '사원', '고객', '환자', '선생',
    '상담', '담당', '대표', '이사', '간호', '직원', '의료진', '지원자', '체험단', '방문자', '예정자',
    '마케터', '디자이너', '작성자', '참여자', '당첨자', '신청자', '문의자', '보호자', '본인', '여러분',
    '모든', '각각', '전원', '이분', '그분', '저분', '다른', '해당', '기존', '신규', '선정', '우리',
    '기사', '강사', '작가', '사장', '회장', '기자', '교수', '박사', '의사', '약사', '변호사', '원무',
    '부원장', '감독', '위원', '소장', '국장', '형님', '선배', '후배', '동기', '외주', '대행사'
  ]);
  const PARTICLES = '에의를을로도와과께서만랑';

  function endsWithParticle(name) {
    return PARTICLES.indexOf(name.charAt(name.length - 1)) !== -1;
  }

  const PATTERNS = [
    {
      // 이름: "이름: 홍길동", "성명은 홍길동" 처럼 라벨 뒤에 구분자(: 은 는)가 있을 때
      type: '이름',
      re: /((?:이름|성명|환자명|고객명|담당자명)\s*(?:[:：]|은|는)\s*)([가-힣]{2,4})(?=$|[^가-힣]|입니|이에요|예요|이고|이며|님|씨|은|는|이|가|을|를|에게|한테|의|과|와|랑)/g,
      replace: (m, label) => label + '[이름]'
    },
    {
      // 이름: 성씨로 시작하는 2~3글자 + 바로 붙은 호칭 (예: 김민수님, 민지씨는 제외 — 성씨 필요)
      type: '이름',
      re: new RegExp('(?<![가-힣])([' + SURNAMES + '][가-힣]{1,2})(님|씨)', 'g'),
      replace: (m, name, title) => (isStop(name) || endsWithParticle(name) ? m : '[이름]' + title)
    },
    {
      // 이름: 성씨로 시작하는 3글자 + 띄어 쓴 직함 (예: 박지영 실장님, 김민수 환자)
      type: '이름',
      re: new RegExp('(?<![가-힣])([' + SURNAMES + '][가-힣]{2})\\s(' + TITLES + ')', 'g'),
      replace: (m, name, title) => (isStop(name) || endsWithParticle(name) ? m : '[이름] ' + title)
    },
    {
      // 휴대폰 번호 (010-1234-5678, 01012345678, 010 1234 5678)
      type: '전화번호',
      re: /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g,
      replace: () => '[전화번호]'
    },
    {
      // 일반 전화번호 (02-123-4567, 031-1234-5678, 1588-1234)
      type: '전화번호',
      re: /(?:0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}|1[5-9]\d{2}[-.\s]\d{4})/g,
      replace: () => '[전화번호]'
    },
    {
      // 사번 (사번 12345, 사원번호: A-1234, 직원번호 EMP2024001)
      type: '사번',
      re: /((?:사번|사원\s?번호|직원\s?번호|사원\s?ID|직원\s?ID)\s*[:：]?\s*)[A-Za-z]{0,4}-?\d{3,12}/gi,
      replace: (m, label) => label + '[사번]'
    }
  ];

  function isStop(name) {
    // '원장님', '상담실장님'처럼 직함 자체가 이름 후보로 잡히는 경우를 거른다.
    for (const w of STOP_WORDS) {
      if (name.endsWith(w) || name.startsWith(w)) return true;
    }
    return false;
  }

  /**
   * @param {string} text 원문
   * @returns {{ masked: string, counts: {이름:number, 전화번호:number, 사번:number}, total: number }}
   */
  function maskText(text) {
    const counts = { '이름': 0, '전화번호': 0, '사번': 0 };
    let out = String(text || '');
    for (const p of PATTERNS) {
      out = out.replace(p.re, function () {
        const args = Array.prototype.slice.call(arguments);
        const original = args[0];
        const replaced = p.replace.apply(null, args);
        if (replaced !== original) counts[p.type] += 1;
        return replaced;
      });
    }
    const total = counts['이름'] + counts['전화번호'] + counts['사번'];
    return { masked: out, counts: counts, total: total };
  }

  const api = { maskText: maskText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediMask = api;
})(typeof window !== 'undefined' ? window : globalThis);
