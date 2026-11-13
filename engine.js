/* Motor de cálculo do apuramento (regras do manual FGP, secção 1).
   Calcula automaticamente totais por série, por ronda e nota de excelência a partir de rotinas. */
(function (root) {
  'use strict';

  var isNum = function (x) { return typeof x === 'number' && isFinite(x); };
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };
  var nfPt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  var fmtPt = function (n) { return nfPt.format(n); };

  var PHASE_NAMES = {
    q1_1: 'Q1 · Série 1',
    q1_2: 'Q1 · Série 2',
    q1: 'Q1',
    q2: 'Q2',
    f: 'Final',
    f1: 'Final 1',
    f2: 'Final 2',
    tf: 'Team Final',
    aa: 'All-Around Team Final'
  };

  /* Calcula o total de uma série a partir de D, E, HD, ToF e Penalização (ou usa total explícito se existir) */
  function calcRoutineTotal(rt) {
    if (!rt) return null;
    if (isNum(rt.total)) return r3(rt.total);
    if (!isNum(rt.d) && !isNum(rt.e)) return null;
    var sum = (isNum(rt.d) ? rt.d : 0) +
              (isNum(rt.e) ? rt.e : 0) +
              (isNum(rt.hd) ? rt.hd : 0) +
              (isNum(rt.tof) ? rt.tof : 0) -
              (isNum(rt.p) ? rt.p : 0);
    return r3(sum);
  }

  /* Normaliza um registo de prova, preenchendo totais de séries, rondas (q1, q2, f, f1, f2) e ne */
  function hydrateRec(rec, tipo) {
    if (!rec) return null;
    var rotSrc = rec.rotinas || {};
    var rot = {};
    var hasRot = false;

    Object.keys(rotSrc).forEach(function (k) {
      var orig = rotSrc[k];
      if (!orig) return;
      var t = calcRoutineTotal(orig);
      rot[k] = Object.assign({}, orig);
      if (t !== null) rot[k].total = t;
      hasRot = true;
    });

    var out = Object.assign({}, rec);
    if (hasRot) out.rotinas = rot;

    if (tipo === 'late') {
      /* TRI: Q1 é a melhor série entre q1_1 e q1_2 */
      var t1 = rot.q1_1 ? rot.q1_1.total : null;
      var t2 = rot.q1_2 ? rot.q1_2.total : null;
      if (!isNum(out.q1)) {
        if (isNum(t1) && isNum(t2)) out.q1 = Math.max(t1, t2);
        else if (isNum(t1)) out.q1 = t1;
        else if (isNum(t2)) out.q1 = t2;
        else if (rot.q1 && isNum(rot.q1.total)) out.q1 = rot.q1.total;
      }
      if (!isNum(out.q2) && rot.q2 && isNum(rot.q2.total)) out.q2 = rot.q2.total;
      if (!isNum(out.f) && rot.f && isNum(rot.f.total)) out.f = rot.f.total;
    } else {
      /* TUM e DMT: Q1 = q1_1 + q1_2; Finais = f1 + f2; NE = maior série individual de toda a prova */
      var qt1 = rot.q1_1 ? rot.q1_1.total : null;
      var qt2 = rot.q1_2 ? rot.q1_2.total : null;
      if (!isNum(out.q1)) {
        if (isNum(qt1) && isNum(qt2)) out.q1 = r3(qt1 + qt2);
        else if (rot.q1 && isNum(rot.q1.total)) out.q1 = rot.q1.total;
      }
      if (!isNum(out.f1) && rot.f1 && isNum(rot.f1.total)) out.f1 = rot.f1.total;
      if (!isNum(out.f2) && rot.f2 && isNum(rot.f2.total)) out.f2 = rot.f2.total;

      if (!isNum(out.ne) && hasRot) {
        var maxSingle = null;
        var maxKey = null;
        Object.keys(rot).forEach(function (k) {
          /* Ignora eventual chave agregada 'q1' se existirem séries individuais */
          if (k === 'q1' && (rot.q1_1 || rot.q1_2)) return;
          var val = rot[k] ? rot[k].total : null;
          if (isNum(val) && (maxSingle === null || val > maxSingle)) {
            maxSingle = val;
            maxKey = k;
          }
        });
        if (maxSingle !== null) {
          out.ne = maxSingle;
          out.nePhase = maxKey;
        }
      }
    }

    return out;
  }

  function resolveQ1Key(rec) {
    if (!rec || !rec.rotinas) return 'q1';
    var r1 = rec.rotinas.q1_1, r2 = rec.rotinas.q1_2;
    if (r1 && r2) return r2.total > r1.total ? 'q1_2' : 'q1_1';
    if (r1) return 'q1_1';
    if (r2) return 'q1_2';
    return 'q1';
  }

  function extractRoutineStats(tipo, rec, phaseKeys) {
    var sumE = 0, sumD = 0, hasDetail = false;
    if (!rec || !rec.rotinas) return { e: 0, d: 0, hasDetail: false };
    phaseKeys.forEach(function (k) {
      var rt = rec.rotinas[k] || (k === 'q1_1' || k === 'q1_2' ? rec.rotinas.q1 : null);
      if (rt) {
        if (isNum(rt.e)) { sumE = r3(sumE + rt.e); hasDetail = true; }
        if (isNum(rt.d)) { sumD = r3(sumD + rt.d); hasDetail = true; }
      }
    });
    return { e: sumE, d: sumD, hasDetail: hasDetail };
  }

  function scoreEvent(disc, sex, rawRec, minimos, tipo, hasMin) {
    var rec = hydrateRec(rawRec, tipo);
    var m = (minimos[disc] || {})[sex] || {};
    var items = [];
    var out = {
      score: 0, items: items, base: null, baseOk: false, neValid: false,
      usedPhases: [], stats: { e: 0, d: 0, hasDetail: false }, hydrated: rec
    };
    if (!rec) return out;

    if (tipo === 'late') {
      var minQ1 = m.q1, minLate = m.late;
      if (isNum(rec.agg)) {
        var ok = rec.agg >= minQ1;
        items.push({
          label: 'Valor da prova (Q1 + melhor fase seguinte)', value: rec.agg, ok: ok,
          note: ''
        });
        out.base = rec.agg;
        out.score = ok ? rec.agg : 0;
        return out;
      }
      if (!isNum(rec.q1)) return out;
      out.base = rec.q1;
      var q1ok = rec.q1 >= minQ1;
      items.push({
        label: 'Q1 (melhor série)', value: rec.q1, ok: q1ok,
        note: ''
      });

      var prevOk = q1ok, best = null, bestKey = null;
      [['q2', 'Q2'], ['f', 'Final']].forEach(function (p) {
        var v = rec[p[0]];
        if (!isNum(v)) return;
        var meetsOwn = v >= minLate;
        var okp = prevOk && meetsOwn;
        var note = (meetsOwn && !prevOk) ? 'fase anterior sem mínimos' : '';
        items.push({ label: p[1], value: v, ok: okp, note: note });
        if (okp && (best === null || v > best)) { best = v; bestKey = p[0]; }
        prevOk = prevOk && meetsOwn;
      });

      if (q1ok) {
        var q1Key = resolveQ1Key(rec);
        out.score = r3(rec.q1 + (best || 0));
        out.usedPhases = bestKey ? [q1Key, bestKey] : [q1Key];
        out.stats = extractRoutineStats('late', rec, out.usedPhases);
      }
      return out;
    }

    /* tipo 'ne': TUM e DMT */
    var minBase = m.base, minNe = m.ne;
    var cand = [];
    var q1Ok = false;

    if (isNum(rec.agg)) {
      var okA = rec.agg >= minBase;
      items.push({
        label: 'Valor da prova (Q1 ou F1+F2)', value: rec.agg, ok: okA,
        note: ''
      });
      out.base = rec.agg;
      if (okA) cand.push({ val: rec.agg, keys: [] });
    } else {
      if (isNum(rec.q1)) {
        q1Ok = rec.q1 >= minBase;
        items.push({
          label: 'Q1', value: rec.q1, ok: q1Ok,
          note: ''
        });
        out.base = rec.q1;
        if (q1Ok) cand.push({ val: rec.q1, keys: ['q1_1', 'q1_2'] });
      }
      if (isNum(rec.f1) && isNum(rec.f2)) {
        var ff = r3(rec.f1 + rec.f2);
        var meetsF = ff >= minBase;
        var okF = q1Ok && meetsF;
        var noteF = (meetsF && !q1Ok) ? 'fase anterior sem mínimos' : '';
        items.push({
          label: 'F1 + F2', value: ff, ok: okF,
          note: noteF
        });
        if (q1Ok && (out.base === null || ff > out.base)) out.base = ff;
        if (okF) cand.push({ val: ff, keys: ['f1', 'f2'] });
      }
    }

    var bestCand = null;
    cand.forEach(function (c) {
      if (!bestCand || c.val > bestCand.val) bestCand = c;
    });

    var base = bestCand ? bestCand.val : 0;
    out.baseOk = base > 0;
    out.usedPhases = bestCand ? bestCand.keys : [];
    out.stats = extractRoutineStats('ne', rec, out.usedPhases);

    var allowed = hasMin === undefined ? out.baseOk : hasMin;
    if (isNum(rec.ne)) {
      var meetsNe = rec.ne >= minNe;
      var okN = allowed && meetsNe;
      var phaseLabel = rec.nePhase ? (PHASE_NAMES[rec.nePhase] || rec.nePhase) : '';
      var noteParts = [];
      if (phaseLabel) noteParts.push(phaseLabel);
      if (meetsNe && !allowed) {
        noteParts.push('exige o mínimo numa prova');
      }
      items.push({
        label: 'Nota de excelência', value: rec.ne, ok: okN,
        note: noteParts.join(' · ')
      });
      if (okN) {
        out.neValid = true;
        if (rec.nePhase && out.usedPhases.indexOf(rec.nePhase) < 0) {
          out.usedPhases = out.usedPhases.concat([rec.nePhase]);
        }
      }
    } else if (rec.neFlag) {
      items.push({
        label: 'Nota de excelência', value: null, ok: false, pending: true,
        note: 'obtida, valor por introduzir'
      });
    }

    /* A nota de excelência não soma à pontuação da prova */
    out.score = r3(base);
    return out;
  }

  function compareTied(a, b) {
    if (a.best !== b.best) {
      var hi = Math.max(a.best, b.best), lo = Math.min(a.best, b.best);
      return {
        diff: b.best - a.best,
        reason: 'Desempate: prova mais alta (' + fmtPt(hi) + ' vs ' + fmtPt(lo) + ')'
      };
    }
    if (a.hasDetail && b.hasDetail) {
      if (a.sumD !== b.sumD) {
        var hiD = Math.max(a.sumD, b.sumD), loD = Math.min(a.sumD, b.sumD);
        return {
          diff: b.sumD - a.sumD,
          reason: 'Desempate: dificuldade (' + fmtPt(hiD) + ' vs ' + fmtPt(loD) + ')'
        };
      }
      if (a.sumE !== b.sumE) {
        var hiE = Math.max(a.sumE, b.sumE), loE = Math.min(a.sumE, b.sumE);
        return {
          diff: b.sumE - a.sumE,
          reason: 'Desempate: execução (' + fmtPt(hiE) + ' vs ' + fmtPt(loE) + ')'
        };
      }
    }
    if (a.second !== b.second) {
      var hi2 = Math.max(a.second, b.second), lo2 = Math.min(a.second, b.second);
      return {
        diff: b.second - a.second,
        reason: 'Desempate: 2.ª melhor prova (' + fmtPt(hi2) + ' vs ' + fmtPt(lo2) + ')'
      };
    }
    return {
      diff: 0,
      reason: (!a.hasDetail || !b.hasDetail) ? 'Empate (aguarda detalhe D/E)' : 'Empate técnico'
    };
  }

  function rank(cfg, disc, sex, entries, results, overrides) {
    var dcfg = cfg.disciplinas[disc];
    var evs = cfg.eventos.filter(function (e) { return e.disciplinas.indexOf(disc) >= 0; });
    var m = (cfg.minimos[disc] || {})[sex] || {};
    var minBase = dcfg.tipo === 'late' ? m.q1 : m.base;

    var rows = entries.map(function (en) {
      var per = {}, scoredList = [], sim = false, bestRaw = null, recs = {}, hasMin = false, hasValidNe = false;

      evs.forEach(function (ev) {
        var ov = overrides && overrides[ev.id] && overrides[ev.id][en.id];
        var rec = ov || (results[ev.id] && results[ev.id][en.id]) || null;
        if (ov) sim = true;
        recs[ev.id] = { rec: rec, ov: !!ov };
        var pre = scoreEvent(disc, sex, rec, cfg.minimos, dcfg.tipo);
        if (dcfg.tipo === 'late' ? pre.score > 0 : pre.baseOk) hasMin = true;
      });

      evs.forEach(function (ev) {
        var rr = recs[ev.id];
        var s = scoreEvent(disc, sex, rr.rec, cfg.minimos, dcfg.tipo, hasMin);
        if (s.neValid) hasValidNe = true;
        per[ev.id] = {
          rec: s.hydrated || rr.rec,
          score: s.score,
          items: s.items,
          simulated: rr.ov,
          neValid: s.neValid,
          usedPhases: s.usedPhases,
          stats: s.stats
        };
        if (s.score > 0) {
          scoredList.push({ evId: ev.id, score: s.score, stats: s.stats });
        }
        if (s.base !== null && (bestRaw === null || s.base > bestRaw)) bestRaw = s.base;
      });

      scoredList.sort(function (a, b) { return b.score - a.score; });
      var top2 = scoredList.slice(0, 2);
      var total = r3((top2[0] ? top2[0].score : 0) + (top2[1] ? top2[1].score : 0));

      var sumD = 0, sumE = 0, hasDetail = top2.length > 0;
      top2.forEach(function (x) {
        if (!x.stats || !x.stats.hasDetail) hasDetail = false;
        else {
          sumD = r3(sumD + x.stats.d);
          sumE = r3(sumE + x.stats.e);
        }
      });

      return {
        entry: en,
        per: per,
        total: total,
        hasValidNe: hasValidNe,
        nCont: top2.length,
        nProvas: scoredList.length,
        best: top2[0] ? top2[0].score : 0,
        second: top2[1] ? top2[1].score : 0,
        sumD: sumD,
        sumE: sumE,
        hasDetail: hasDetail,
        bestRaw: bestRaw,
        gap: bestRaw !== null && minBase ? r3(minBase - bestRaw) : null,
        simulated: sim,
        rank: null,
        tie: false,
        tieReason: '',
        naVaga: false
      };
    });

    var ranked = rows.filter(function (r) { return r.total > 0; });
    var rest = rows.filter(function (r) { return r.total <= 0; });

    ranked.sort(function (a, b) {
      /* Quem tem Nota de Excelência válida fica num patamar prioritário acima de quem não tem */
      if (a.hasValidNe !== b.hasValidNe) return a.hasValidNe ? -1 : 1;
      if (b.total !== a.total) return b.total - a.total;
      var cmp = compareTied(a, b);
      if (cmp.diff !== 0) return cmp.diff;
      return a.entry.nome.localeCompare(b.entry.nome, 'pt');
    });

    ranked.forEach(function (r, i) {
      if (i > 0 && ranked[i - 1].hasValidNe === r.hasValidNe && ranked[i - 1].total === r.total) {
        var cmp = compareTied(ranked[i - 1], r);
