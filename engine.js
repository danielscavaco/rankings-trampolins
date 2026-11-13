/* Motor de cálculo do apuramento (regras do manual FGP, secção 1).
   Sem dependências: corre no browser e em Node. */
(function (root) {
  'use strict';

  var isNum = function (x) { return typeof x === 'number' && isFinite(x); };
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };
  var nfPt = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  var fmtPt = function (n) { return nfPt.format(n); };

  function extractRoutineStats(tipo, rec, phaseKeys) {
    var sumE = 0, sumD = 0, hasDetail = false;
    if (!rec || !rec.rotinas) return { e: 0, d: 0, hasDetail: false };
    phaseKeys.forEach(function (k) {
      var rt = rec.rotinas[k];
      if (rt) {
        if (isNum(rt.e)) { sumE = r3(sumE + rt.e); hasDetail = true; }
        if (isNum(rt.d)) { sumD = r3(sumD + rt.d); hasDetail = true; }
      }
    });
    return { e: sumE, d: sumD, hasDetail: hasDetail };
  }

  function scoreEvent(disc, sex, rec, minimos, tipo, hasMin) {
    var m = (minimos[disc] || {})[sex] || {};
    var items = [];
    var out = {
      score: 0, items: items, base: null, baseOk: false, neAdd: 0,
      usedPhases: [], stats: { e: 0, d: 0, hasDetail: false }
    };
    if (!rec) return out;

    if (tipo === 'late') {
      var minQ1 = m.q1, minLate = m.late;
      if (isNum(rec.agg)) {
        var ok = rec.agg >= minQ1;
        items.push({
          label: 'Valor da prova (Q1 + melhor fase seguinte)', value: rec.agg, ok: ok,
          note: ok ? '' : 'abaixo do mínimo de Q1 (' + fmtPt(minQ1) + ')'
        });
        out.base = rec.agg;
        out.score = ok ? rec.agg : 0;
        return out;
      }
      if (!isNum(rec.q1)) return out;
      out.base = rec.q1;
      var q1ok = rec.q1 >= minQ1;
      items.push({
        label: 'Q1', value: rec.q1, ok: q1ok,
        note: q1ok ? '' : 'abaixo do mínimo (' + fmtPt(minQ1) + ')'
      });

      var prevOk = q1ok, best = null, bestKey = null;
      [['q2', 'Q2'], ['f', 'Final']].forEach(function (p) {
        var v = rec[p[0]];
        if (!isNum(v)) return;
        var okp = prevOk && v >= minLate;
        var note = '';
        if (!okp) note = !prevOk ? 'fase anterior sem mínimos' : 'abaixo do mínimo (' + fmtPt(minLate) + ')';
        items.push({ label: p[1], value: v, ok: okp, note: note });
        if (okp && (best === null || v > best)) { best = v; bestKey = p[0]; }
        prevOk = prevOk && v >= minLate;
      });

      if (q1ok) {
        out.score = r3(rec.q1 + (best || 0));
        out.usedPhases = bestKey ? ['q1', bestKey] : ['q1'];
        out.stats = extractRoutineStats('late', rec, out.usedPhases);
      }
      return out;
    }

    /* tipo 'ne': TUM e DMT */
    var minBase = m.base, minNe = m.ne;
    var cand = [];
    if (isNum(rec.agg)) {
      var okA = rec.agg >= minBase;
      items.push({
        label: 'Valor da prova (Q1 ou F1+F2)', value: rec.agg, ok: okA,
        note: okA ? '' : 'abaixo do mínimo (' + fmtPt(minBase) + ')'
      });
      out.base = rec.agg;
      if (okA) cand.push({ val: rec.agg, keys: [] });
    } else {
      if (isNum(rec.q1)) {
        var okQ = rec.q1 >= minBase;
        items.push({
          label: 'Q1', value: rec.q1, ok: okQ,
          note: okQ ? '' : 'abaixo do mínimo (' + fmtPt(minBase) + ')'
        });
        out.base = rec.q1;
        if (okQ) cand.push({ val: rec.q1, keys: ['q1_1', 'q1_2'] });
      }
      if (isNum(rec.f1) && isNum(rec.f2)) {
        var ff = r3(rec.f1 + rec.f2), okF = ff >= minBase;
        items.push({
          label: 'F1 + F2', value: ff, ok: okF,
          note: okF ? '' : 'abaixo do mínimo (' + fmtPt(minBase) + ')'
        });
        if (out.base === null || ff > out.base) out.base = ff;
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
    var neAdd = 0;
    if (isNum(rec.ne)) {
      var okN = allowed && rec.ne >= minNe;
      items.push({
        label: 'Nota de excelência', value: rec.ne, ok: okN,
        note: okN ? '' : (!allowed ? 'exige o mínimo numa prova' : 'abaixo do mínimo (' + fmtPt(minNe) + ')')
      });
      if (okN) neAdd = rec.ne;
    } else if (rec.neFlag) {
      items.push({
        label: 'Nota de excelência', value: null, ok: false, pending: true,
        note: 'obtida, valor por introduzir'
      });
    }

    out.neAdd = neAdd;
    out.score = r3(base + neAdd);
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
      var per = {}, scoredList = [], sim = false, bestRaw = null, recs = {}, hasMin = false;

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
        per[ev.id] = {
          rec: rr.rec,
          score: s.score,
          items: s.items,
          simulated: rr.ov,
          neAdd: s.neAdd || 0,
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
      if (b.total !== a.total) return b.total - a.total;
      var cmp = compareTied(a, b);
      if (cmp.diff !== 0) return cmp.diff;
      return a.entry.nome.localeCompare(b.entry.nome, 'pt');
    });

    ranked.forEach(function (r, i) {
      if (i > 0 && ranked[i - 1].total === r.total) {
        var cmp = compareTied(ranked[i - 1], r);
        if (cmp.diff === 0) {
          r.rank = ranked[i - 1].rank;
          r.tie = true;
          ranked[i - 1].tie = true;
          r.tieReason = cmp.reason;
          ranked[i - 1].tieReason = cmp.reason;
        } else {
          r.rank = i + 1;
          r.tieReason = cmp.reason;
          if (!ranked[i - 1].tieReason) ranked[i - 1].tieReason = cmp.reason;
        }
      } else {
        r.rank = i + 1;
      }
      r.naVaga = r.rank <= dcfg.vagas;
    });

    rest.sort(function (a, b) {
      var av = a.bestRaw === null ? -1 : a.bestRaw, bv = b.bestRaw === null ? -1 : b.bestRaw;
      return (bv - av) || a.entry.nome.localeCompare(b.entry.nome, 'pt');
    });

    return {
      rows: ranked.concat(rest),
      vagas: dcfg.vagas,
      comMinimos: ranked.length,
      minBase: minBase,
      minimos: m,
      eventos: evs
    };
  }

  var api = { scoreEvent: scoreEvent, rank: rank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Apuramento = api;
})(typeof self !== 'undefined' ? self : this);
