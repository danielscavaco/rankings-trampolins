/* Motor genérico de cálculo do apuramento:
   1) Motor "fgp_minimos": rankings nacionais por mínimos e notas (EG27, CM27, etc.)
   2) Motor "fig_olympic": apuramento olímpico FIG + ranking nacional FGP (JO28) */
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

  /* Tabela de Pontos FIG Taças do Mundo (Art. 16) */
  var FIG_WC_POINTS = {
    1: 60, 2: 55, 3: 50, 4: 44, 5: 38, 6: 32, 7: 28, 8: 25, 9: 22, 10: 21,
    11: 20, 12: 19, 13: 18, 14: 17, 15: 16, 16: 15, 17: 14, 18: 13, 19: 12, 20: 11,
    21: 10, 22: 9, 23: 8, 24: 7, 25: 6, 26: 5, 27: 4, 28: 3, 29: 2, 30: 1
  };

  /* =========================================================================
     MOTOR 1: APURAMENTO NACIONAL POR MÍNIMOS (EG27, CM27, etc.)
     ========================================================================= */
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

  function scoreEvent(disc, sex, rawRec, minimos, tipo, useExcelencia) {
    var rec = hydrateRec(rawRec, tipo);
    var m = (minimos[disc] || {})[sex] || {};
    var items = [];
    var out = {
      score: 0, items: items, base: null, baseOk: false,
      neReached: false, neValid: false, nePhase: null,
      usedPhases: [], stats: { e: 0, d: 0, hasDetail: false }, hydrated: rec
    };
    if (!rec) return out;

    if (tipo === 'late') {
      var minQ1 = m.q1, minLate = m.late;
      if (isNum(rec.agg)) {
        var ok = rec.agg >= minQ1;
        items.push({ label: 'Valor da prova (Q1 + melhor fase seguinte)', value: rec.agg, ok: ok, note: '' });
        out.base = rec.agg;
        out.score = ok ? rec.agg : 0;
        return out;
      }
      if (!isNum(rec.q1)) return out;
      out.base = rec.q1;
      var q1ok = rec.q1 >= minQ1;
      items.push({ label: 'Q1 (melhor série)', value: rec.q1, ok: q1ok, note: '' });

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

    var minBase = m.base, minNe = m.ne;
    var allowNe = useExcelencia !== false && isNum(minNe);
    var cand = [];
    var q1Ok = false;

    if (isNum(rec.agg)) {
      var okA = rec.agg >= minBase;
      items.push({ label: 'Valor da prova (Q1 ou F1+F2)', value: rec.agg, ok: okA, note: '' });
      out.base = rec.agg;
      q1Ok = okA;
      if (okA) cand.push({ val: rec.agg, keys: [] });
    } else {
      if (isNum(rec.q1)) {
        q1Ok = rec.q1 >= minBase;
        items.push({ label: 'Q1', value: rec.q1, ok: q1Ok, note: '' });
        out.base = rec.q1;
        if (q1Ok) cand.push({ val: rec.q1, keys: ['q1_1', 'q1_2'] });
      }
      if (isNum(rec.f1) && isNum(rec.f2)) {
        var ff = r3(rec.f1 + rec.f2);
        var meetsF = ff >= minBase;
        var okF = q1Ok && meetsF;
        var noteF = (meetsF && !q1Ok) ? 'fase anterior sem mínimos' : '';
        items.push({ label: 'F1 + F2', value: ff, ok: okF, note: noteF });
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

    var neAdd = 0;
    if (allowNe) {
      if (isNum(rec.ne)) {
        var meetsNe = rec.ne >= minNe;
        var okN = q1Ok && meetsNe;
        var phaseLabel = rec.nePhase ? (PHASE_NAMES[rec.nePhase] || rec.nePhase) : '';
        var noteParts = [];
        if (phaseLabel) noteParts.push(phaseLabel);
        if (meetsNe && !q1Ok) noteParts.push('exige mínimos na Q1');
        items.push({ label: 'Nota de excelência', value: rec.ne, ok: okN, note: noteParts.join(' · ') });
        out.nePhase = rec.nePhase || null;
        if (meetsNe) out.neReached = true;
        if (okN) {
          out.neValid = true;
          neAdd = rec.ne;
        }
      } else if (rec.neFlag) {
        items.push({ label: 'Nota de excelência', value: null, ok: false, pending: true, note: 'obtida, valor por introduzir' });
        out.neReached = true;
        if (q1Ok) out.neValid = true;
      }
    }

    out.score = base > 0 ? r3(base + neAdd) : 0;
    return out;
  }

  function compareTied(a, b) {
    if (a.best !== b.best) {
      var hi = Math.max(a.best, b.best), lo = Math.min(a.best, b.best);
      return { diff: b.best - a.best, reason: 'Desempate: prova mais alta (' + fmtPt(hi) + ' vs ' + fmtPt(lo) + ')' };
    }
    if (a.hasDetail && b.hasDetail) {
      if (a.sumD !== b.sumD) {
        var hiD = Math.max(a.sumD, b.sumD), loD = Math.min(a.sumD, b.sumD);
        return { diff: b.sumD - a.sumD, reason: 'Desempate: dificuldade (' + fmtPt(hiD) + ' vs ' + fmtPt(loD) + ')' };
      }
      if (a.sumE !== b.sumE) {
        var hiE = Math.max(a.sumE, b.sumE), loE = Math.min(a.sumE, b.sumE);
        return { diff: b.sumE - a.sumE, reason: 'Desempate: execução (' + fmtPt(hiE) + ' vs ' + fmtPt(loE) + ')' };
      }
    }
    if (a.second !== b.second) {
      var hi2 = Math.max(a.second, b.second), lo2 = Math.min(a.second, b.second);
      return { diff: b.second - a.second, reason: 'Desempate: 2.ª melhor prova (' + fmtPt(hi2) + ' vs ' + fmtPt(lo2) + ')' };
    }
    return { diff: 0, reason: (!a.hasDetail || !b.hasDetail) ? 'Empate (aguarda detalhe D/E)' : 'Empate técnico' };
  }

  function rank(cfg, disc, sex, entries, results, overrides) {
    var dcfg = cfg.disciplinas[disc];
    var evs = cfg.eventos.filter(function (e) { return e.disciplinas.indexOf(disc) >= 0; });
    var m = (cfg.minimos[disc] || {})[sex] || {};
    var minBase = dcfg.tipo === 'late' ? m.q1 : m.base;
    var nContar = isNum(dcfg.provasContam) ? dcfg.provasContam : (isNum(cfg.provasContam) ? cfg.provasContam : 2);
    var useExcelencia = dcfg.usarExcelencia !== undefined ? dcfg.usarExcelencia : (cfg.usarExcelencia !== false);

    var rows = entries.map(function (en) {
      var per = {}, scoredList = [], sim = false, bestRaw = null, hasValidNe = false;

      evs.forEach(function (ev) {
        var ov = overrides && overrides[ev.id] && overrides[ev.id][en.id];
        var rec = ov || (results[ev.id] && results[ev.id][en.id]) || null;
        if (ov) sim = true;
        var s = scoreEvent(disc, sex, rec, cfg.minimos, dcfg.tipo, useExcelencia);
        if (s.neValid) hasValidNe = true;
        per[ev.id] = {
          rec: s.hydrated || rec,
          score: s.score,
          items: s.items,
          simulated: !!ov,
          neReached: s.neReached,
          neValid: s.neValid,
          nePhase: s.nePhase,
          usedPhases: s.usedPhases,
          stats: s.stats
        };
        if (s.score > 0) scoredList.push({ evId: ev.id, score: s.score, stats: s.stats });
        if (s.base !== null && (bestRaw === null || s.base > bestRaw)) bestRaw = s.base;
      });

      scoredList.sort(function (a, b) { return b.score - a.score; });
      var topN = scoredList.slice(0, nContar);
      var total = r3(topN.reduce(function (acc, item) { return acc + item.score; }, 0));
      var usedEvMap = {};
      topN.forEach(function (x) { usedEvMap[x.evId] = true; });

      var sumD = 0, sumE = 0, hasDetail = topN.length > 0;
      topN.forEach(function (x) {
        if (!x.stats || !x.stats.hasDetail) hasDetail = false;
        else { sumD = r3(sumD + x.stats.d); sumE = r3(sumE + x.stats.e); }
      });

      return {
        entry: en, per: per, total: total, hasValidNe: hasValidNe,
        nCont: topN.length, nProvas: scoredList.length, usedEvMap: usedEvMap,
        best: topN[0] ? topN[0].score : 0, second: topN[1] ? topN[1].score : 0,
        sumD: sumD, sumE: sumE, hasDetail: hasDetail,
        bestRaw: bestRaw, gap: bestRaw !== null && minBase ? r3(minBase - bestRaw) : null,
        simulated: sim, rank: null, tie: false, tieReason: '', naVaga: false
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
      provasContam: nContar,
      useExcelencia: useExcelencia,
      comMinimos: ranked.length,
      minBase: minBase,
      minimos: m,
      eventos: evs
    };
  }

  /* =========================================================================
     MOTOR 2: APURAMENTO OLÍMPICO FIG + NACIONAL FGP (JO28)
     ========================================================================= */
  function pointsFromRank(rk) {
    if (!isNum(rk) || rk < 1 || rk > 30) return 0;
    return FIG_WC_POINTS[Math.floor(rk)] || 0;
  }

  function computeEventPointsMap(evId, sexResults) {
    var evRes = sexResults[evId] || {};
    var byRank = {};
    Object.keys(evRes).forEach(function (athId) {
      var r = evRes[athId];
      if (!r || !isNum(r.rank) || r.valid === false) return;
      var rk = Math.floor(r.rank);
      (byRank[rk] = byRank[rk] || []).push(athId);
    });
    var ptsMap = {};
    Object.keys(byRank).forEach(function (rkStr) {
      var rk = Number(rkStr);
      var group = byRank[rk];
      var sum = 0;
      for (var i = 0; i < group.length; i++) {
        sum += pointsFromRank(rk + i);
      }
      var avg = Math.round((sum / group.length) * 100) / 100;
      group.forEach(function (id) { ptsMap[id] = avg; });
    });
    return ptsMap;
  }

  function selectBestResults(items, bestCount, maxPerYear) {
    var sorted = items.slice().sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      return (a.rank || 999) - (b.rank || 999);
    });
    var chosen = [];
    var countByYear = {};
    sorted.forEach(function (it) {
      if (chosen.length >= bestCount) return;
      var yrKey = String(it.ano);
      var yrLimit = maxPerYear && isNum(maxPerYear[yrKey]) ? maxPerYear[yrKey] : Infinity;
      var curYrCount = countByYear[yrKey] || 0;
      if (curYrCount >= yrLimit) return;
      chosen.push(it);
      countByYear[yrKey] = curYrCount + 1;
    });
    var total = Math.round(chosen.reduce(function (acc, x) { return acc + x.pts; }, 0) * 100) / 100;
    var usedMap = {};
    chosen.forEach(function (x) { usedMap[x.evId] = true; });
    return { total: total, chosen: chosen, usedMap: usedMap };
  }

  function compareFigTie(a, b) {
    if (a.sumRanks !== b.sumRanks) {
      return { diff: a.sumRanks - b.sumRanks, reason: 'Desempate FIG: soma lugares (' + a.sumRanks + ' vs ' + b.sumRanks + ')' };
    }
    if (a.finalsCount !== b.finalsCount) {
      return { diff: b.finalsCount - a.finalsCount, reason: 'Desempate FIG: n.º de finais (' + b.finalsCount + ' vs ' + a.finalsCount + ')' };
    }
    if (a.bestRank !== b.bestRank) {
      return { diff: a.bestRank - b.bestRank, reason: 'Desempate FIG: melhor lugar (' + a.bestRank + 'º vs ' + b.bestRank + 'º)' };
    }
    if (a.sumQ1_2 !== b.sumQ1_2) {
      return { diff: b.sumQ1_2 - a.sumQ1_2, reason: 'Desempate FIG: soma 2.ª série Q1 (' + fmtPt(b.sumQ1_2) + ' vs ' + fmtPt(a.sumQ1_2) + ')' };
    }
    return { diff: 0, reason: 'Empate FIG' };
  }

  function compareFgpTie(a, b) {
    if (a.bestScore !== b.bestScore) {
      return { diff: b.bestScore - a.bestScore, reason: 'Desempate FGP: nota mais alta (' + fmtPt(Math.max(a.bestScore, b.bestScore)) + ' vs ' + fmtPt(Math.min(a.bestScore, b.bestScore)) + ')' };
    }
    if (a.bestD !== b.bestD) {
      return { diff: b.bestD - a.bestD, reason: 'Desempate FGP: D mais alta (' + fmtPt(Math.max(a.bestD, b.bestD)) + ' vs ' + fmtPt(Math.min(a.bestD, b.bestD)) + ')' };
    }
    if (a.sumD !== b.sumD) {
      return { diff: b.sumD - a.sumD, reason: 'Desempate FGP: soma D (' + fmtPt(Math.max(a.sumD, b.sumD)) + ' vs ' + fmtPt(Math.min(a.sumD, b.sumD)) + ')' };
    }
    if (a.bestE !== b.bestE) {
      return { diff: b.bestE - a.bestE, reason: 'Desempate FGP: E mais alta (' + fmtPt(Math.max(a.bestE, b.bestE)) + ' vs ' + fmtPt(Math.min(a.bestE, b.bestE)) + ')' };
    }
    if (a.sumE !== b.sumE) {
      return { diff: b.sumE - a.sumE, reason: 'Desempate FGP: soma E (' + fmtPt(Math.max(a.sumE, b.sumE)) + ' vs ' + fmtPt(Math.min(a.sumE, b.sumE)) + ')' };
    }
    if (a.secondScore !== b.secondScore) {
      return { diff: b.secondScore - a.secondScore, reason: 'Desempate FGP: 2.ª nota mais alta' };
    }
    if (a.thirdScore !== b.thirdScore) {
      return { diff: b.thirdScore - a.thirdScore, reason: 'Desempate FGP: 3.ª nota mais alta' };
    }
    return { diff: 0, reason: 'Empate FGP' };
  }

  function rankLA28(laCfg, sex, overrides) {
    var rules = laCfg.regras || {};
    var TOTAL_QUOTAS = isNum(rules.totalQuotas) ? rules.totalQuotas : 16;
    var CRIT1_MAX = isNum(rules.crit1Max) ? rules.crit1Max : 8;
    var MAX_SECOND_QUOTA_NOCS = isNum(rules.maxSecondQuotaNocs) ? rules.maxSecondQuotaNocs : 3;
    var SECOND_QUOTA_MAX_POS = isNum(rules.secondQuotaMaxWcPos) ? rules.secondQuotaMaxWcPos : 3;
    var BEST_RESULTS_COUNT = isNum(rules.bestResultsCount) ? rules.bestResultsCount : 3;
    var MAX_RESULTS_YEAR = rules.maxResultsYear || { '2027': 2 };
    var HOST_NOC = (rules.hostNoc || 'USA').toUpperCase();

    var unionDefs = Array.isArray(laCfg.unioes) && laCfg.unioes.length ? laCfg.unioes : [
      { code: 'EG', label: 'Europa (EG)' },
      { code: 'AGU', label: 'Ásia (AGU)' },
      { code: 'PAGU', label: 'Américas (PAGU)' },
      { code: 'UAG', label: 'África (UAG)' },
      { code: 'OGU', label: 'Oceânia (OGU)' }
    ];

    var baseRes = (laCfg.resultados && laCfg.resultados[sex]) || {};
    var sexRes = {};
    laCfg.eventos.forEach(function (ev) {
      sexRes[ev.id] = Object.assign({}, baseRes[ev.id] || {});
      if (overrides && overrides[sex] && overrides[sex][ev.id]) {
        Object.keys(overrides[sex][ev.id]).forEach(function (athId) {
          var ovRec = overrides[sex][ev.id][athId];
          if (ovRec === null) delete sexRes[ev.id][athId];
          else sexRes[ev.id][athId] = Object.assign({}, sexRes[ev.id][athId] || {}, ovRec);
        });
      }
    });

    var continentsMap = laCfg.nocContinents || {};
    var ptsByEv = {};
    laCfg.eventos.forEach(function (ev) {
      ptsByEv[ev.id] = computeEventPointsMap(ev.id, sexRes);
    });

    /* 1) Recolher todos os atletas que aparecem em qualquer evento */
    var athletes = {};
    laCfg.eventos.forEach(function (ev) {
      var evR = sexRes[ev.id] || {};
      Object.keys(evR).forEach(function (athId) {
        var rec = evR[athId];
        if (!rec) return;
        if (!athletes[athId]) {
          athletes[athId] = { id: athId, nome: rec.nome || athId, noc: (rec.noc || '').toUpperCase() };
        }
      });
    });

    /* 2) Critério 1: Campeonato do Mundo 2027 (Top 8 da Final, máx. 1 por NOC, ordenado por Q2) */
    var wchEv = laCfg.eventos.filter(function (e) { return e.tipo === 'wch'; })[0];
    var crit1ByAth = {};
    var crit1Nocs = {};
    if (wchEv && sexRes[wchEv.id]) {
      var wchR = sexRes[wchEv.id];
      var finalists = Object.keys(wchR).map(function (id) {
        return { id: id, rec: wchR[id] };
      }).filter(function (x) {
        return isNum(x.rec.finalRank) && x.rec.finalRank >= 1 && x.rec.finalRank <= CRIT1_MAX;
      });

      var bestFinalistByNoc = {};
      finalists.forEach(function (f) {
        var noc = (f.rec.noc || '').toUpperCase();
        var prev = bestFinalistByNoc[noc];
        if (!prev) {
          bestFinalistByNoc[noc] = f;
        } else {
          var qPrev = isNum(prev.rec.q2Rank) ? prev.rec.q2Rank : prev.rec.finalRank;
          var qCurr = isNum(f.rec.q2Rank) ? f.rec.q2Rank : f.rec.finalRank;
          if (qCurr < qPrev) bestFinalistByNoc[noc] = f;
        }
      });

      var eligibleCrit1 = Object.keys(bestFinalistByNoc).map(function (noc) {
        return bestFinalistByNoc[noc];
      }).sort(function (a, b) {
        var qa = isNum(a.rec.q2Rank) ? a.rec.q2Rank : a.rec.finalRank;
        var qb = isNum(b.rec.q2Rank) ? b.rec.q2Rank : b.rec.finalRank;
        return (qa - qb) || (a.rec.finalRank - b.rec.finalRank);
      }).slice(0, CRIT1_MAX);

      eligibleCrit1.forEach(function (item, idx) {
        var noc = (item.rec.noc || '').toUpperCase();
        var q2r = isNum(item.rec.q2Rank) ? item.rec.q2Rank : item.rec.finalRank;
        crit1ByAth[item.id] = { quotaRank: idx + 1, finalRank: item.rec.finalRank, q2Rank: q2r };
        crit1Nocs[noc] = item.id;
      });
    }

    /* 3) Preparar dados de todos os atletas nas Taças do Mundo */
    var wcEvents = laCfg.eventos.filter(function (e) { return e.tipo === 'wc'; });
    var allFigRows = Object.keys(athletes).map(function (athId) {
      var ath = athletes[athId];
      var per = {};
      var validItems = [];
      var isSim = false;

      wcEvents.forEach(function (ev) {
        var rec = (sexRes[ev.id] && sexRes[ev.id][athId]) || null;
        var ovFlag = Boolean(overrides && overrides[sex] && overrides[sex][ev.id] && overrides[sex][ev.id][athId] !== undefined);
        if (ovFlag) isSim = true;
        var pts = ptsByEv[ev.id][athId] || 0;
        per[ev.id] = { rec: rec, pts: pts, used: false, simulated: ovFlag };
        if (rec && pts > 0) {
          validItems.push({
            evId: ev.id,
            ano: ev.ano,
            pts: pts,
            rank: rec.rank || 999,
            final: Boolean(rec.final || (isNum(rec.rank) && rec.rank <= 8)),
            q1_2: isNum(rec.q1_2) ? rec.q1_2 : 0
          });
        }
      });

      var sel = selectBestResults(validItems, BEST_RESULTS_COUNT, MAX_RESULTS_YEAR);
      Object.keys(sel.usedMap).forEach(function (evId) { per[evId].used = true; });

      var sumRanks = sel.chosen.reduce(function (a, x) { return a + x.rank; }, 0);
      var finalsCount = sel.chosen.reduce(function (a, x) { return a + (x.final ? 1 : 0); }, 0);
      var bestRank = sel.chosen.length ? Math.min.apply(null, sel.chosen.map(function (x) { return x.rank; })) : 999;
      var sumQ1_2 = r3(sel.chosen.reduce(function (a, x) { return a + x.q1_2; }, 0));

      return {
        ath: ath,
        per: per,
        total: sel.total,
        nCont: sel.chosen.length,
        sumRanks: sumRanks,
        finalsCount: finalsCount,
        bestRank: bestRank,
        sumQ1_2: sumQ1_2,
        crit1: crit1ByAth[athId] || null,
        nocHasCrit1: Boolean(crit1Nocs[ath.noc]),
        simulated: isSim,
        displayRank: null,
        status: 'out',
        statusLabel: '',
        tieReason: ''
      };
    });

    var crit1Group = allFigRows.filter(function (r) { return Boolean(r.crit1); }).sort(function (a, b) {
      return a.crit1.quotaRank - b.crit1.quotaRank;
    });

    var wcGroup = allFigRows.filter(function (r) { return !r.crit1 && r.total > 0; }).sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var cmp = compareFigTie(a, b);
      if (cmp.diff !== 0) return cmp.diff;
      return a.ath.nome.localeCompare(b.ath.nome, 'pt');
    });

    wcGroup.forEach(function (r, i) {
      if (i > 0 && wcGroup[i - 1].total === r.total) {
        var cmp = compareFigTie(wcGroup[i - 1], r);
        if (cmp.diff !== 0) {
          r.tieReason = cmp.reason;
          if (!wcGroup[i - 1].tieReason) wcGroup[i - 1].tieReason = cmp.reason;
        }
      }
    });

    /* 4) Atribuir # 1..N e simular alocação dinâmica de vagas */
    var crit1Count = crit1Group.length;
    crit1Group.forEach(function (r, idx) {
      r.displayRank = idx + 1;
      r.status = 'crit1';
      r.statusLabel = 'Critério 1 · CM 2027';
    });

    var nocQuotas = {};
    Object.keys(crit1Nocs).forEach(function (noc) { nocQuotas[noc] = 1; });
    var secondQuotaCountries = 0;
    var nextRankNum = crit1Count + 1;
    var crit2Candidates = [];

    wcGroup.forEach(function (r, idx) {
      var noc = r.ath.noc;
      var currentNocQ = nocQuotas[noc] || 0;
      var worldCupPos = idx + 1;

      if (currentNocQ === 0) {
        nocQuotas[noc] = 1;
        r.displayRank = nextRankNum++;
        crit2Candidates.push(r);
      } else if (currentNocQ === 1 && crit1Nocs[noc] && worldCupPos <= SECOND_QUOTA_MAX_POS && secondQuotaCountries < MAX_SECOND_QUOTA_NOCS) {
        nocQuotas[noc] = 2;
        secondQuotaCountries++;
        r.isSecondQuota = true;
        r.displayRank = nextRankNum++;
        crit2Candidates.push(r);
      } else {
        r.displayRank = null;
        r.status = 'noc_full';
        r.statusLabel = 'País já com vaga';
      }
    });

    function evaluateReservations(qualifiedList) {
      var contWinner = {};
      var hostWinner = false;
      qualifiedList.forEach(function (item) {
        if (item.noc === HOST_NOC) hostWinner = true;
        var c = continentsMap[item.noc];
        if (c && !contWinner[c]) contWinner[c] = item.noc;
      });
      var missingCont = unionDefs.filter(function (cd) { return !contWinner[cd.code]; }).length;
      var hostMissing = hostWinner ? 0 : 1;
      return {
        contWinner: contWinner,
        hostWinner: hostWinner,
        totalReserved: missingCont + hostMissing
      };
    }

    var maxPool = TOTAL_QUOTAS - crit1Count;
    var qualifiedEntries = crit1Group.map(function (r) { return { noc: r.ath.noc }; });

    crit2Candidates.forEach(function (r, cIdx) {
      var slotNum = cIdx + 1;
      if (slotNum > maxPool) {
        r.status = 'out';
        r.statusLabel = 'Fora das vagas';
        return;
      }
      var nextEntries = qualifiedEntries.concat([{ noc: r.ath.noc }]);
      var resInfo = evaluateReservations(nextEntries);
      var safePool = TOTAL_QUOTAS - crit1Count - resInfo.totalReserved;

      if (slotNum <= safePool) {
        r.status = 'crit2_safe';
        r.statusLabel = r.isSecondQuota ? 'Critério 2 · 2ª vaga' : 'Critério 2 · Garantido';
        qualifiedEntries = nextEntries;
      } else {
        r.status = 'crit2_bubble';
        r.statusLabel = 'Zona de corte';
        qualifiedEntries = nextEntries;
      }
    });

    var finalReservations = evaluateReservations(qualifiedEntries);
    var safeCrit2Slots = Math.max(0, TOTAL_QUOTAS - crit1Count - finalReservations.totalReserved);
    var bubbleCrit2Slots = Math.max(0, maxPool - safeCrit2Slots);

    var continentTrackers = unionDefs.map(function (cd) {
      return {
        id: cd.code,
        label: cd.label,
        qualified: Boolean(finalReservations.contWinner[cd.code]),
        byNoc: finalReservations.contWinner[cd.code] || null
      };
    });
    continentTrackers.push({
      id: 'HOST',
      label: 'Anfitrião (' + HOST_NOC + ')',
      qualified: finalReservations.hostWinner,
      byNoc: finalReservations.hostWinner ? HOST_NOC : null
    });

    var figActive = crit1Group.concat(wcGroup);
    var porFigRows = figActive.filter(function (r) { return r.ath.noc === 'POR'; });
    var porQuotasSafe = porFigRows.filter(function (r) { return r.status === 'crit1' || r.status === 'crit2_safe'; }).length;
    var porQuotasBubble = porFigRows.filter(function (r) { return r.status === 'crit2_bubble'; }).length;

    /* 5) Ranking Nacional FGP */
    var allEvents = laCfg.eventos;
    var porIds = Object.keys(athletes).filter(function (id) { return athletes[id].noc === 'POR'; });
    var fgpRows = porIds.map(function (athId) {
      var ath = athletes[athId];
      var per = {};
      var validItems = [];
      var allScores = [];
      var bestD = 0, bestE = 0;
      var isSim = false;

      allEvents.forEach(function (ev) {
        var rec = (sexRes[ev.id] && sexRes[ev.id][athId]) || null;
        var ovFlag = Boolean(overrides && overrides[sex] && overrides[sex][ev.id] && overrides[sex][ev.id][athId] !== undefined);
        if (ovFlag) isSim = true;
        var pts = ptsByEv[ev.id][athId] || 0;
        per[ev.id] = { rec: rec, pts: pts, used: false, simulated: ovFlag };
        if (rec) {
          var sc = isNum(rec.bestScore) ? rec.bestScore : 0;
          var dVal = isNum(rec.bestD) ? rec.bestD : 0;
          var eVal = isNum(rec.bestE) ? rec.bestE : 0;
          if (sc > 0) allScores.push(sc);
          if (dVal > bestD) bestD = dVal;
          if (eVal > bestE) bestE = eVal;
          if (pts > 0) {
            validItems.push({
              evId: ev.id,
              ano: ev.ano,
              pts: pts,
              rank: rec.rank || 999,
              bestScore: sc,
              bestD: dVal,
              bestE: eVal
            });
          }
        }
      });

      var sel = selectBestResults(validItems, BEST_RESULTS_COUNT, MAX_RESULTS_YEAR);
      Object.keys(sel.usedMap).forEach(function (evId) { per[evId].used = true; });

      allScores.sort(function (a, b) { return b - a; });
      var sumD = r3(sel.chosen.reduce(function (a, x) { return a + x.bestD; }, 0));
      var sumE = r3(sel.chosen.reduce(function (a, x) { return a + x.bestE; }, 0));

      return {
        ath: ath,
        per: per,
        total: sel.total,
        nCont: sel.chosen.length,
        bestScore: allScores[0] || 0,
        secondScore: allScores[1] || 0,
        thirdScore: allScores[2] || 0,
        bestD: bestD,
        sumD: sumD,
        bestE: bestE,
        sumE: sumE,
        simulated: isSim,
        rank: null,
        tieReason: '',
        quotaState: 'out'
      };
    });

    fgpRows.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var cmp = compareFgpTie(a, b);
      if (cmp.diff !== 0) return cmp.diff;
      return a.ath.nome.localeCompare(b.ath.nome, 'pt');
    });

    fgpRows.forEach(function (r, i) {
      if (i > 0 && fgpRows[i - 1].total === r.total && r.total > 0) {
        var cmp = compareFgpTie(fgpRows[i - 1], r);
        if (cmp.diff !== 0) {
          r.tieReason = cmp.reason;
          if (!fgpRows[i - 1].tieReason) fgpRows[i - 1].tieReason = cmp.reason;
        }
      }
      r.rank = r.total > 0 ? (i + 1) : null;
      if (r.rank !== null) {
        if (r.rank <= porQuotasSafe) r.quotaState = 'safe';
        else if (r.rank <= (porQuotasSafe + porQuotasBubble)) r.quotaState = 'bubble';
      }
    });

    return {
      eventos: allEvents,
      wcEvents: wcEvents,
      wchEvent: wchEv,
      figRows: figActive,
      fgpRows: fgpRows,
      continentTrackers: continentTrackers,
      summary: {
        totalQuotas: TOTAL_QUOTAS,
        crit1Count: crit1Count,
        safeCrit2Slots: safeCrit2Slots,
        bubbleCrit2Slots: bubbleCrit2Slots,
        reservedSlots: finalReservations.totalReserved,
        porQuotasSafe: porQuotasSafe,
        porQuotasBubble: porQuotasBubble,
        bestResultsCount: BEST_RESULTS_COUNT,
        hostNoc: HOST_NOC
      }
    };
  }

  var api = {
    scoreEvent: scoreEvent,
    rank: rank,
    hydrateRec: hydrateRec,
    rankLA28: rankLA28,
    pointsFromRank: pointsFromRank
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Apuramento = api;
})(typeof self !== 'undefined' ? self : this);
