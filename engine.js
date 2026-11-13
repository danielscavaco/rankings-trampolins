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
        var noteF = (meetsF && !q1Ok) ? 'Q1 sem mínimos' : '';
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
