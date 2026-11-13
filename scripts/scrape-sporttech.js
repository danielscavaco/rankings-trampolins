#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURAÇÃO DO ENSAIO SPORTTECH
// ============================================================================
const CONFIG = {
  sporttechBaseUrl: 'https://sporttech.io/events/56c681e4-f2c2-45df-787d-ea9164169d95/ovs/',
  eventoId: 'cn_teste',
  athletesFile: path.resolve(__dirname, '../data/test-athletes.json'),
  resultsFile: path.resolve(__dirname, '../data/test-results.json'),
  logFile: path.resolve(__dirname, 'scrape-report.log'),
  pollIntervalMs: 30000
};

const args = process.argv.slice(2);
const IS_CHECK_ONLY = args.includes('--check');
const IS_LIVE_LOOP = args.includes('--live');

// Mapeamentos nativos da API Sporttech OVS
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

function firstLastKey(fullName) {
  const parts = stripAccents(fullName)
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

function synNameKey(pairName) {
  return String(pairName || '')
    .split(/[\/&+]/)
    .map(firstLastKey)
    .filter(Boolean)
    .sort()
    .join(' | ');
}

function normalizeSex(sexCat) {
  const s = stripAccents(sexCat);
  if (s === 'female' || s === 'f' || s === 'women' || s === 'girls') return 'F';
  if (s === 'male' || s === 'm' || s === 'men' || s === 'boys') return 'M';
  if (s === 'mix' || s === 'mixed' || s === 'x') return 'Mix';
  return String(sexCat || '').toUpperCase();
}

// Mapeia o escalão da Sporttech (AgeGroup / Title) para os escalões do site
function mapEscalao(comp) {
  const raw = stripAccents(`${comp.AgeGroup || ''} ${comp.Title || ''}`);
  if (/inic\s*1d|11-12|ag\s*1\b/.test(raw)) return ['11-12'];
  if (/juv\s*1d|13-14|ag\s*2\b/.test(raw)) return ['13-14'];
  if (/jun\s*elite|15-16|\bjun\b|junior/.test(raw)) return ['JUN', '13-14'];
  if (/sen\s*1d|17-21|ag\s*3\b|ag\s*4\b/.test(raw)) return ['17-21'];
  if (/sen\s*elite|\bsen\b|senior|open/.test(raw)) return ['SEN'];
  return [];
}

// ============================================================================
// CÁLCULO DE DETALHE DA ROTINA (E, D, HD, TOF, PEN, TOTAL)
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

  // 3. Por Primeiro + Último Nome (ordenado no caso de SYN) + Clube
  const targetKey = isSyn ? synNameKey(ath.nome) : firstLastKey(ath.nome);
  if (!targetKey) return null;

  const candidates = stageEntries.filter(e => {
    const eKey = isSyn ? synNameKey(e.nome) : firstLastKey(e.nome);
    return eKey === targetKey;
  });

  if (candidates.length === 1) {
    return { entry: candidates[0], method: 'Nome (1.º + Último)' };
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
// EXECUÇÃO PRINCIPAL
// ============================================================================
const stageCache = new Map();

async function runSync() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const apiBase = CONFIG.sporttechBaseUrl.replace(/\/+$/, '') + '/api/';

  const athletes = JSON.parse(fs.readFileSync(CONFIG.athletesFile, 'utf8'));
  let resultsDoc = { live: true, atualizadoEm: nowStr, resultados: { [CONFIG.eventoId]: {} } };
  if (fs.existsSync(CONFIG.resultsFile)) {
    resultsDoc = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
  }
  resultsDoc.resultados = resultsDoc.resultados || {};
  resultsDoc.resultados[CONFIG.eventoId] = resultsDoc.resultados[CONFIG.eventoId] || {};

  const logLines = [
    `====================================================================`,
    `RELATÓRIO SPORTTECH OVS (${IS_CHECK_ONLY ? 'VERIFICAÇÃO START LIST' : 'LIVE SYNC'}) — ${nowStr}`,
    `API: ${apiBase}`,
    `====================================================================`,
    ``
  ];

  let evData;
  try {
    evData = await fetchApiJson(apiBase + 'event?fetch_event_competitions=true&fetch_competition_stages=true');
  } catch (err) {
    logLines.push(`[ERRO CRÍTICO] Falha ao ler API Sporttech: ${err.message}`);
    fs.writeFileSync(CONFIG.logFile, logLines.join('\n'), 'utf8');
    console.error(logLines.join('\n'));
    return;
  }

  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};
  const stageList = [];

  for (const [cid, c] of Object.entries(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc) continue;
    const sexo = normalizeSex(c.SexCategory);
    const escaloes = mapEscalao(c);

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);
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

  logLines.push(`Stages carregados da Sporttech: ${stageList.length}`);
  stageList.forEach(st => {
    logLines.push(`  • [${st.sid}] ${st.title} -> ${st.disc} | Escalões: [${st.escaloes.join(', ') || '?'}] | Sexo: ${st.sexo} | Fase: ${st.fase} (${st.entries.length} inscritos)`);
  });
  logLines.push(``);
  logLines.push(`--- CRUZAMENTO DE GINASTAS (${athletes.length} no JSON) ---`);

  let matchedCount = 0;
  let missingCount = 0;
  let updatedScores = 0;

  for (const ath of athletes) {
    const relevantStages = stageList.filter(st => {
      if (st.disc !== ath.disc) return false;
      if (st.sexo && st.sexo !== ath.sexo) return false;
      if (st.escaloes.length > 0 && !st.escaloes.includes(ath.escalao)) return false;
      return true;
    });

    if (relevantStages.length === 0) {
      missingCount++;
      logLines.push(`[ERRO - SEM PROVA] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Nenhuma prova correspondente na Sporttech.`);
      continue;
    }

    let foundAny = false;
    const evRec = resultsDoc.resultados[CONFIG.eventoId][ath.id] || { rotinas: {} };
    evRec.rotinas = evRec.rotinas || {};

    for (const st of relevantStages) {
      const m = matchAthlete(ath, st.entries);
      if (m) {
        foundAny = true;
        const e = m.entry;
        const faseKey = st.fase;
        logLines.push(`[OK] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo}) -> "${st.title}" [${faseKey}] via ${m.method} | Total: ${e.total ?? 'sem nota'}`);

        if (!IS_CHECK_ONLY && e.total !== null) {
          evRec[faseKey] = e.total;
          if (faseKey === 'q1' && e.routines.length > 0) {
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
      if (!IS_CHECK_ONLY && Object.keys(evRec.rotinas).length > 0) {
        resultsDoc.resultados[CONFIG.eventoId][ath.id] = evRec;
      }
    } else {
      missingCount++;
      logLines.push(`[ERRO - NÃO ENCONTRADO] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Não aparece em "${relevantStages.map(s => s.title).join(' / ')}".`);
    }
  }

  logLines.push(``);
  logLines.push(`RESUMO: ${matchedCount} encontrados | ${missingCount} com erro/não encontrados | ${updatedScores} fases atualizadas.`);

  fs.writeFileSync(CONFIG.logFile, logLines.join('\n'), 'utf8');
  console.log(logLines.join('\n'));

  if (!IS_CHECK_ONLY) {
    resultsDoc.atualizadoEm = nowStr;
    fs.writeFileSync(CONFIG.resultsFile, JSON.stringify(resultsDoc, null, 2), 'utf8');
  }
}

(async () => {
  await runSync();
  if (IS_LIVE_LOOP) {
    setInterval(runSync, CONFIG.pollIntervalMs);
  }
})();
