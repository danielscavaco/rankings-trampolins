#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const TARGETS_FILE = path.resolve(__dirname, 'live-targets.json');
const LOG_FILE = path.resolve(__dirname, 'scrape-report.log');
const POLL_INTERVAL_MS = 10000;

const args = process.argv.slice(2);
const IS_CHECK_ONLY = args.includes('--check');
const IS_LIVE_LOOP = args.includes('--live');

const DISC_MAP = { 0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM' };
const KIND_MAP = { 0: 'q1', 6: 'q2', 3: 'f', 8: 'f1', 7: 'f2' };

// ============================================================================
// NORMALIZAÇÃO DE NOMES, CLUBES E ESCALÕES
// ============================================================================
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

// Expande abreviaturas (mesmo coladas ao nome: "MªClara" -> "maria clara") e limpa partículas
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
  if (s === 'female' || s === 'f' || s === 'women' || s === 'girls') return 'F';
  if (s === 'male' || s === 'm' || s === 'men' || s === 'boys') return 'M';
  if (s === 'mix' || s === 'mixed' || s === 'x') return 'Mix';
  return String(sexCat || '').toUpperCase();
}

// Mapeia apenas provas competitivas relevantes (em provas nacionais exige 1D ou Elite)
function mapEscalao(comp) {
  const raw = stripAccents(`${comp.AgeGroup || ''} ${comp.Title || ''}`);

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
  return [];
}

// ============================================================================
// CÁLCULO DE DETALHE DA ROTINA E REGRA DE SINCRONIZADO POR ESCALÃO
// ============================================================================
function parseFrameDetail(f) {
  const T = (f.MarkTTT_G || 0) / 1000.0;
  const E = f.ETotalT_G || 0;
  const D = (f.DifficultyT_G || 0) / 10.0;
  const H = f.Displacement_G || 0;
  const X = f.TimeTMS_G || 0;
  const P = (f.PenaltyT || 0) / 10.0;
  const B = (f.BonusT || 0) / 10.0;

  const out = {
    e: 0,
    d: Number(D.toFixed(3)),
    hd: 0,
    tof: 0,
    p: Number(P.toFixed(3)),
    total: Number(T.toFixed(3))
  };

  for (const e of [E / 10.0, E / 1000.0, E / 100.0]) {
    for (const h of [H / 100.0, H / 10.0, H / 1000.0]) {
      for (const x of [X / 1000.0, (X * 2) / 100.0, X / 100.0, X / 10.0]) {
        if (Math.abs(e + D + h + x + B - P - T) < 0.006) {
          out.e = Number(e.toFixed(3));
          out.hd = Number(h.toFixed(3));
          out.tof = Number(x.toFixed(3));
          return out;
        }
      }
    }
  }
  return out;
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

// ============================================================================
// CLIENTE API SPORTTECH OVS
// ============================================================================
async function fetchApiJson(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (RankingsTrampolins Live Relay)',
          'Accept': 'application/json'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === 2) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// ============================================================================
// MATCHING EM CASCATA
// ============================================================================
function matchAthlete(ath, stageEntries) {
  const isSyn = ath.disc === 'SYN';

  // 1. Por número de filiado
  if (ath.filiado) {
    const byFil = stageEntries.find(e => e.filiados.includes(String(ath.filiado).trim()));
    if (byFil) return { entry: byFil, method: `Filiado (${ath.filiado})` };
  }

  // 2. Por FIG ID
  if (ath.figId) {
    const byFig = stageEntries.find(e => e.figIds.includes(String(ath.figId).trim()));
    if (byFig) return { entry: byFig, method: `FIG ID (${ath.figId})` };
  }

  // 3. Por Nome Normalizado (tokens flexíveis + Mª/M.) + Clube
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

// ============================================================================
// CARREGAMENTO DE STAGES DA SPORTTECH (1 LEITURA POR CICLO)
// ============================================================================
const stageCache = new Map();

async function loadAllStages(apiBase, logLines) {
  const evData = await fetchApiJson(apiBase + 'event?fetch_event_competitions=true&fetch_competition_stages=true');
  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};
  const stageList = [];

  for (const [, c] of Object.entries(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc) continue;
    const sexo = normalizeSex(c.SexCategory);
    const escaloes = mapEscalao(c);
    if (escaloes.length === 0) continue;

    const isSenOnly = escaloes.length === 1 && escaloes[0] === 'SEN';

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);

      // Apenas SEN recolhe Q2 e Finais (f, f1, f2); os restantes escalões só recolhem q1
      if (!isSenOnly && fase !== 'q1') {
        continue;
      }

      const cacheKey = `${st.LastEdit_G}|${st.FinishedFrames_G}|${st.InProgress_G}`;

      let det = stageCache.get(String(sid));
      if (!det || det.cacheKey !== cacheKey) {
        try {
          const rawDet = await fetchApiJson(
            `${apiBase}stages/${sid}?fetch_stage_groups=true&fetch_group_performances=true&fetch_performance_athletes=true&fetch_performance_frames=true`
          );
          det = { cacheKey, data: rawDet };
          stageCache.set(String(sid), det);
        } catch (err) {
          logLines.push(`[AVISO] Erro ao ler stage ${sid} (${c.Title}): ${err.message}`);
          continue;
        }
      }

      const A = det.data.Athletes || {};
      const P = det.data.Performances || {};
      const F = det.data.Frames || {};
      const lim = st.PerfomanceFramesLimit || 2;

      const entries = [];
      for (const p of Object.values(P)) {
        const athObjs = (p.Athletes || [])
          .map(aid => A[String(aid)] || A[aid])
          .filter(Boolean);
        if (!athObjs.length) continue;

        const fullNames = athObjs.map(a => `${a.GivenName || ''} ${a.Surname || ''}`.trim());
        const clubes = athObjs.map(a => cleanClub(a.Club || a.Team || a.Representing || ''));
        const filiados = athObjs.map(a => String(a.FederationID || a.License || a.NationalID || '').trim()).filter(Boolean);
        const figIds = athObjs.map(a => String(a.FIGID || a.FigId || a.LicenseFIG || '').trim()).filter(Boolean);

        const routines = [];
        for (const fid of (p.Frames || []).slice(0, lim)) {
          const f = F[String(fid)] || F[fid];
          if (!f) continue;
          const mk = f.MarkTTT_G || 0;
          if (mk > 0 && (f.State || 0) >= 3) {
            routines.push(parseFrameDetail(f));
          }
        }

        const totalMk = (p.MarkTTT_G || 0) > 0 ? Number(((p.MarkTTT_G || 0) / 1000.0).toFixed(3)) : null;

        entries.push({
          nome: fullNames.join(' / '),
          clubes,
          filiados,
          figIds,
          total: totalMk,
          routines
        });
      }

      stageList.push({
        sid: String(sid),
        title: `${c.Title || ''} (${c.AgeGroup || ''})`.trim(),
        disc,
        sexo,
        escaloes,
        fase,
        entries
      });
    }
  }
  return stageList;
}

// ============================================================================
// EXECUÇÃO PRINCIPAL (PARA TODOS OS TARGETS EM LIVE-TARGETS.JSON)
// ============================================================================
async function runSync() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const liveCfg = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
  const apiBase = String(liveCfg.sporttechUrl || '').replace(/\/+$/, '') + '/api/';
  const targets = liveCfg.targets || [];

  const logLines = [
    `====================================================================`,
    `RELATÓRIO SPORTTECH OVS (${IS_CHECK_ONLY ? 'VERIFICAÇÃO START LIST' : 'LIVE SYNC'}) — ${nowStr}`,
    `API: ${apiBase}`,
    `Competições alvo: ${targets.map(t => t.nome).join(' | ')}`,
    `====================================================================`,
    ``
  ];

  let stageList;
  try {
    stageList = await loadAllStages(apiBase, logLines);
  } catch (err) {
    logLines.push(`[ERRO CRÍTICO] Falha ao ler API Sporttech: ${err.message}`);
    fs.writeFileSync(LOG_FILE, logLines.join('\n'), 'utf8');
    console.error(logLines.join('\n'));
    return;
  }

  logLines.push(`Stages competitivos carregados da Sporttech: ${stageList.length}`);
  stageList.forEach(st => {
    logLines.push(`  • [${st.sid}] ${st.title} -> ${st.disc} | Escalões: [${st.escaloes.join(', ')}] | Sexo: ${st.sexo} | Fase: ${st.fase} (${st.entries.length} inscritos)`);
  });

  for (const target of targets) {
    const athPath = path.resolve(__dirname, '..', target.athletesFile);
    const resPath = path.resolve(__dirname, '..', target.resultsFile);
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
      const relevantStages = stageList.filter(st => {
        if (st.disc !== ath.disc) return false;
        if (st.sexo && st.sexo !== ath.sexo) return false;
        if (!st.escaloes.includes(ath.escalao)) return false;
        return true;
      });

      if (relevantStages.length === 0) {
        missingCount++;
        logLines.push(`[ERRO - SEM PROVA] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Nenhuma prova correspondente na Sporttech.`);
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

          if (!IS_CHECK_ONLY && qScore !== null) {
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
        if (!IS_CHECK_ONLY && (Object.keys(evRec.rotinas).length > 0 || evRec.q1 !== undefined)) {
          nextEventData[ath.id] = evRec;
        }
      } else {
        missingCount++;
        logLines.push(`[ERRO - NÃO ENCONTRADO] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Não aparece em "${relevantStages.map(s => s.title).join(' / ')}".`);
      }
    }

    logLines.push(`RESUMO (${target.nome}): ${matchedCount} encontrados | ${missingCount} com erro/não encontrados | ${updatedScores} fases atualizadas.`);

    if (!IS_CHECK_ONLY) {
      resultsDoc.resultados[eventoId] = nextEventData;
      // Só atualiza o timestamp se os dados realmente mudaram (evita commits desnecessários)
      if (JSON.stringify(prevEventData) !== JSON.stringify(nextEventData)) {
        resultsDoc.atualizadoEm = nowStr;
        fs.writeFileSync(resPath, JSON.stringify(resultsDoc, null, 2), 'utf8');
      }
    }
  }

  fs.writeFileSync(LOG_FILE, logLines.join('\n'), 'utf8');
  console.log(logLines.join('\n'));
}

(async () => {
  await runSync();
  if (IS_LIVE_LOOP) {
    setInterval(runSync, POLL_INTERVAL_MS);
  }
})();
