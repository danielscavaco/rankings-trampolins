'use strict';

const fs = require('fs');
const path = require('path');

function stripAccents(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function cleanClub(c) {
  return String(c || '').replace(/^POR\s*[,/-]\s*/i, '').trim();
}

function nameTokens(fullName) {
  const expanded = String(fullName || '')
    .replace(/(^|\s)m\.?\s*[ªa](?=[A-ZÀ-Ýa-zà-ÿ\s]|$)/g, '$1maria ')
    .replace(/(^|\s)j\.?\s*[ºo](?=[A-ZÀ-Ýa-zà-ÿ\s]|$)/g, '$1joao ')
    .replace(/(^|\s)m\.(?=\s*[A-ZÀ-Ý])/g, '$1maria ');

  return stripAccents(expanded)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !['de', 'da', 'do', 'das', 'dos', 'e'].includes(w));
}

function isSamePerson(nameA, nameB) {
  const tA = nameTokens(nameA);
  const tB = nameTokens(nameB);
  if (!tA.length || !tB.length) return false;

  const flA = `${tA[0]} ${tA[tA.length - 1]}`;
  const flB = `${tB[0]} ${tB[tB.length - 1]}`;
  const flBRev = `${tB[tB.length - 1]} ${tB[0]}`;
  if (flA === flB || flA === flBRev) return true;

  const [shorter, longer] = tA.length <= tB.length ? [tA, tB] : [tB, tA];
  if (shorter.length >= 2 && shorter.every(tok => longer.includes(tok))) {
    return true;
  }

  return false;
}

function normalizeSex(sexCat) {
  const s = stripAccents(sexCat);
  if (/\b(women|woman|female|girls|girl|f)\b/.test(s)) return 'F';
  if (/\b(men|man|male|boys|boy|m)\b/.test(s)) return 'M';
  if (/\b(mix|mixed|x)\b/.test(s)) return 'Mix';
  return String(sexCat || '').toUpperCase();
}

function mapEscalaoText(rawInput, { allowDefaultSenior = false } = {}) {
  const raw = stripAccents(rawInput);

  if (/\b(base|2d|2a\s*div)\b/.test(raw)) return [];

  const isNacional = /\b(inic|juv|jun|sen)\b/.test(raw);
  if (isNacional && !/\b(1d|elite)\b/.test(raw)) {
    return [];
  }

  if (/inic\s*1d|11-12|ag\s*1\b/.test(raw)) return ['11-12'];
  if (/juv\s*1d|13-14|ag\s*2\b/.test(raw)) return ['13-14'];
  if (/jun\s*(1d|elite)|15-16|\bjun\b|junior/.test(raw)) return ['JUN', '13-14'];
  if (/sen\s*1d|17-21|ag\s*3\b|ag\s*4\b/.test(raw)) return ['17-21'];
  if (/sen\s*elite|\bsen\b|senior|open/.test(raw)) return ['SEN'];

  // Provas FIG/Internacionais (ex: Swiss Timing "Men's Tumbling - Qualification") não dizem "Senior"
  return allowDefaultSenior ? ['SEN'] : [];
}

function computeEffectiveScore(ath, entry, faseKey) {
  if (ath.disc !== 'SYN' || faseKey !== 'q1') {
    const bestSingle = entry.routines.length > 0
      ? Math.max(...entry.routines.map(r => r.total))
      : entry.total;
    return { qScore: entry.total, singleScore: bestSingle };
  }

  const r1 = entry.routines[0] ? entry.routines[0].total : null;
  const r2 = entry.routines[1] ? entry.routines[1].total : null;

  if (ath.escalao === 'JUN') {
    const sum = (r1 !== null && r2 !== null) ? Number((r1 + r2).toFixed(3)) : (entry.total ?? r1);
    const best = Math.max(...[r1, r2].filter(v => v !== null));
    return { qScore: sum, singleScore: Number.isFinite(best) ? best : null };
  }

  if (ath.escalao === '17-21') {
    return { qScore: r1, singleScore: r1 };
  }

  if (ath.escalao === '11-12' || ath.escalao === '13-14') {
    const chosen = r2 !== null ? r2 : r1;
    return { qScore: chosen, singleScore: chosen };
  }

  return { qScore: entry.total, singleScore: r1 };
}

function matchAthlete(ath, stageEntries) {
  const isSyn = ath.disc === 'SYN';

  if (ath.filiado) {
    const byFil = stageEntries.find(e => e.filiados.includes(String(ath.filiado).trim()));
    if (byFil) return { entry: byFil, method: `Filiado (${ath.filiado})` };
  }

  if (ath.figId) {
    const byFig = stageEntries.find(e => e.figIds.includes(String(ath.figId).trim()));
    if (byFig) return { entry: byFig, method: `FIG ID (${ath.figId})` };
  }

  const candidates = stageEntries.filter(e => {
    if (!isSyn) {
      return isSamePerson(ath.nome, e.nome);
    }
    const athMembers = String(ath.nome || '').split(/[\/&+]/).map(s => s.trim()).filter(Boolean);
    const stMembers = String(e.nome || '').split(/[\/&+]/).map(s => s.trim()).filter(Boolean);
    if (athMembers.length !== 2 || stMembers.length !== 2) return false;
    return (
      (isSamePerson(athMembers[0], stMembers[0]) && isSamePerson(athMembers[1], stMembers[1])) ||
      (isSamePerson(athMembers[0], stMembers[1]) && isSamePerson(athMembers[1], stMembers[0]))
    );
  });

  if (candidates.length === 1) {
    return { entry: candidates[0], method: 'Nome' };
  }
  if (candidates.length > 1) {
    const athClubs = String(ath.clube || '').split('/').map(cleanClub);
    const byClub = candidates.find(c => c.clubes.some(cl => athClubs.includes(cl)));
    if (byClub) return { entry: byClub, method: `Nome + Clube (${byClub.clubes.join(' / ')})` };
    return { entry: candidates[0], method: 'Nome (1.º encontrado)' };
  }

  return null;
}

async function fetchWithRetry(url, { accept = 'application/json' } = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RankingsTrampolins/2.0',
          'Accept': accept
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return accept.includes('json') ? await res.json() : await res.text();
    } catch (err) {
      if (i === 2) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

function applyStagesToTarget({ target, stageList, nowStr, isCheckOnly, logLines, rootDir }) {
  const athPath = path.resolve(rootDir, target.athletesFile);
  const resPath = path.resolve(rootDir, target.resultsFile);
  const eventoId = target.eventoId;

  const athletes = JSON.parse(fs.readFileSync(athPath, 'utf8'));
  let resultsDoc = { live: true, atualizadoEm: nowStr, resultados: { [eventoId]: {} } };
  if (fs.existsSync(resPath)) {
    resultsDoc = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  }
  resultsDoc.resultados = resultsDoc.resultados || {};
  const prevEventData = resultsDoc.resultados[eventoId] || {};
  const nextEventData = {};

  logLines.push(``);
  logLines.push(`====================================================================`);
  logLines.push(`DESTINO: ${target.nome} (${target.resultsFile} -> "${eventoId}")`);
  logLines.push(`====================================================================`);

  let matchedCount = 0;
  let missingCount = 0;
  let updatedScores = 0;

  for (const ath of athletes) {
    const normDisc = d => (d === 'TRA' ? 'TRI' : d);

    const relevantStages = stageList.filter(st => {
      if (normDisc(st.disc) !== normDisc(ath.disc)) return false;
      if (st.sexo && st.sexo !== ath.sexo) return false;
      if (!st.escaloes.includes(ath.escalao)) return false;
      return true;
    });;

    if (relevantStages.length === 0) {
      missingCount++;
      logLines.push(`[ERRO - SEM PROVA] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Nenhuma prova correspondente encontrada.`);
      continue;
    }

    let foundAny = false;
    const evRec = { ...(prevEventData[ath.id] || {}), rotinas: { ...((prevEventData[ath.id] || {}).rotinas || {}) } };

    for (const st of relevantStages) {
      const m = matchAthlete(ath, st.entries);
      if (m) {
        foundAny = true;
        const e = m.entry;
        const faseKey = st.fase;
        const { qScore, singleScore } = computeEffectiveScore(ath, e, faseKey);

        logLines.push(`[OK] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo}) -> "${st.title}" [${faseKey}] via ${m.method} | Nota: ${qScore ?? 'sem nota'} (séries: ${e.routines.map(r => r.total).join(' + ') || '—'})`);

        if (!isCheckOnly && qScore !== null) {
          evRec[faseKey] = qScore;
          if (faseKey === 'q1') {
            if (singleScore !== null) evRec.late = singleScore;
            if (e.routines[0]) evRec.rotinas.q1_1 = e.routines[0];
            if (e.routines[1]) evRec.rotinas.q1_2 = e.routines[1];
          } else if (e.routines.length > 0) {
            evRec.rotinas[faseKey] = e.routines[0];
          }
          updatedScores++;
        }
      }
    }

    if (foundAny) {
      matchedCount++;
      if (!isCheckOnly && (Object.keys(evRec.rotinas).length > 0 || evRec.q1 !== undefined)) {
        nextEventData[ath.id] = evRec;
      }
    } else {
      missingCount++;
      logLines.push(`[ERRO - NÃO ENCONTRADO] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Não aparece em "${relevantStages.map(s => s.title).join(' / ')}".`);
    }
  }

  logLines.push(`RESUMO (${target.nome}): ${matchedCount} encontrados | ${missingCount} com erro/não encontrados | ${updatedScores} fases atualizadas.`);

  if (!isCheckOnly) {
    resultsDoc.resultados[eventoId] = nextEventData;
    if (JSON.stringify(prevEventData) !== JSON.stringify(nextEventData)) {
      resultsDoc.atualizadoEm = nowStr;
      fs.writeFileSync(resPath, JSON.stringify(resultsDoc, null, 2), 'utf8');
    }
  }
}

module.exports = {
  stripAccents,
  cleanClub,
  isSamePerson,
  normalizeSex,
  mapEscalaoText,
  computeEffectiveScore,
  matchAthlete,
  fetchWithRetry,
  applyStagesToTarget
};
