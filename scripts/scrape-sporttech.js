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
const IS_DUMP_ATHLETES = args.includes('--dump-athletes');

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

// Expande abreviaturas comuns (ex: "Mª", "M.ª", "M.a" -> "maria") e extrai "primeiro ultimo"
function firstLastKey(fullName) {
  const expanded = String(fullName || '')
    .replace(/(^|\s)m\.?\s*[ªa](?=\s|$)/gi, '$1maria')
    .replace(/(^|\s)j\.?\s*[ºo](?=\s|$)/gi, '$1joao');

  const parts = stripAccents(expanded)
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

// Mapeia apenas provas competitivas relevantes (em provas nacionais exige 1D ou Elite)
function mapEscalao(comp) {
  const raw = stripAccents(`${comp.AgeGroup || ''} ${comp.Title || ''}`);

  // Ignora explicitamente divisões Base / 2D
  if (/\b(base|2d|2a\s*div)\b/.test(raw)) return [];

  // Provas Nacionais (prefixo Inic / Juv / Jun / Sen): obrigatório ser 1D ou Elite
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

/**
 * Calcula a pontuação de qualificação (q1) e melhor série (late) segundo a disciplina e escalão:
 * - SYN JUN: soma das duas séries (r1 + r2)
 * - SYN 17-21: apenas a 1.ª série (r1)
 * - SYN 11-12 e 13-14: apenas a 2.ª série (r2), exceto se só houver 1 série (extra concurso -> r1)
 * - TRI / DMT / TUM: total da qualificação (p.MarkTTT_G) e melhor série individual
 */
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
    // Se tiver 2 séries, conta apenas a 2.ª; se só tiver 1 (extra concurso), usa a 1.ª
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

  // 3. Por Primeiro + Último Nome (com normalização de Mª/M.ª e ordenado em SYN) + Clube
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
// CARREGAMENTO DE STAGES DA SPORTTECH
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
    if (escaloes.length === 0) continue; // Ignora divisões Base / 2D ou não mapeadas

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
// GERADOR AUTOMÁTICO DE TEST-ATHLETES.JSON (--dump-athletes)
// ============================================================================
async function dumpTestAthletes(stageList) {
  const generated = [];
  const seenKeys = new Set();

  // Seleciona apenas stages de qualificação (q1) para não duplicar ginastas da final
  const q1Stages = stageList.filter(s => s.fase === 'q1');

  for (const st of q1Stages) {
    // Escolhe o escalão principal (no caso de Jun 1D / Jun Elite, usa 'JUN')
    const esc = st.escaloes[0];
    // Apanha até 6 ginastas/pares por prova para termos uma amostra rica
    for (const e of st.entries.slice(0, 6)) {
      const slug = stripAccents(e.nome).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const id = `${st.disc.toLowerCase()}_${esc.replace('-', '')}_${st.sexo.toLowerCase()}_${slug}`;
      if (seenKeys.has(id)) continue;
      seenKeys.add(id);

      const rec = {
        id,
        nome: e.nome,
        clube: e.clubes.filter(Boolean).join(' / ') || 'POR',
        disc: st.disc,
        escalao: esc,
        sexo: st.sexo
      };
      if (e.filiados.length === 1) rec.filiado = e.filiados[0];
      if (e.figIds.length === 1) rec.figId = e.figIds[0];
      generated.push(rec);
    }
  }

  // Adiciona 3 ginastas fictícios propositados para validar os alertas de erro no log
  generated.push(
    {
      id: 'erro_1_nome_inventado',
      nome: 'Zé Ninguém Inexistente',
      clube: 'SCP',
      disc: 'TRI',
      escalao: 'SEN',
      sexo: 'M'
    },
    {
      id: 'erro_2_escalao_trocado',
      nome: 'Diogo Abreu',
      clube: 'SCP',
      disc: 'TRI',
      escalao: '11-12',
      sexo: 'M'
    },
    {
      id: 'erro_3_syn_inexistente',
      nome: 'Atleta Fantasma A / Atleta Fantasma B',
      clube: 'GCN / AAC',
      disc: 'SYN',
      escalao: '13-14',
      sexo: 'F'
    }
  );

  fs.writeFileSync(CONFIG.athletesFile, JSON.stringify(generated, null, 2), 'utf8');
  console.log(`Gerado ${CONFIG.athletesFile} com ${generated.length} entradas (${generated.length - 3} reais + 3 de erro).`);
}

// ============================================================================
// EXECUÇÃO PRINCIPAL
// ============================================================================
async function runSync() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const apiBase = CONFIG.sporttechBaseUrl.replace(/\/+$/, '') + '/api/';

  const logLines = [
    `====================================================================`,
    `RELATÓRIO SPORTTECH OVS (${IS_CHECK_ONLY ? 'VERIFICAÇÃO START LIST' : 'LIVE SYNC'}) — ${nowStr}`,
    `API: ${apiBase}`,
    `====================================================================`,
    ``
  ];

  let stageList;
  try {
    stageList = await loadAllStages(apiBase, logLines);
  } catch (err) {
    logLines.push(`[ERRO CRÍTICO] Falha ao ler API Sporttech: ${err.message}`);
    fs.writeFileSync(CONFIG.logFile, logLines.join('\n'), 'utf8');
    console.error(logLines.join('\n'));
    return;
  }

  if (IS_DUMP_ATHLETES) {
    await dumpTestAthletes(stageList);
  }

  const athletes = JSON.parse(fs.readFileSync(CONFIG.athletesFile, 'utf8'));
  let resultsDoc = { live: true, atualizadoEm: nowStr, resultados: { [CONFIG.eventoId]: {} } };
  if (fs.existsSync(CONFIG.resultsFile)) {
    resultsDoc = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
  }
  resultsDoc.resultados = resultsDoc.resultados || {};
  resultsDoc.resultados[CONFIG.eventoId] = {};

  logLines.push(`Stages competitivos carregados da Sporttech (1D/Elite; Q2/Finais só SEN): ${stageList.length}`);
  stageList.forEach(st => {
    logLines.push(`  • [${st.sid}] ${st.title} -> ${st.disc} | Escalões: [${st.escaloes.join(', ')}] | Sexo: ${st.sexo} | Fase: ${st.fase} (${st.entries.length} inscritos)`);
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
      if (!st.escaloes.includes(ath.escalao)) return false;
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
        const { qScore, singleScore } = computeEffectiveScore(ath, e, faseKey);

        logLines.push(`[OK] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo}) -> "${st.title}" [${faseKey}] via ${m.method} | Nota apuramento: ${qScore ?? 'sem nota'} (séries: ${e.routines.map(r => r.total).join(' + ') || '—'})`);

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
