#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURAÇÃO DO ENSAIO SPORTTECH
// ============================================================================
const CONFIG = {
  sporttechUrl: 'https://sporttech.io/events/56c681e4-f2c2-45df-787d-ea9164169d95/ovs/event/TRA',
  eventoId: 'cn_teste',
  athletesFile: path.resolve(__dirname, '../data/test-athletes.json'),
  resultsFile: path.resolve(__dirname, '../data/test-results.json'),
  logFile: path.resolve(__dirname, 'scrape-report.log'),
  pollIntervalMs: 60000
};

const args = process.argv.slice(2);
const IS_CHECK_ONLY = args.includes('--check');
const IS_LIVE_LOOP = args.includes('--live');

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

// Extrai "primeiro ultimo" nome normalizado (ex: "Diogo Miguel Abreu" -> "diogo abreu")
function firstLastKey(fullName) {
  const parts = stripAccents(fullName)
    .replace(/[^a-z\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
}

// Chave normalizada para pares de Sincronizado (ordena os 2 ginastas alfabeticamente)
function synNameKey(pairName) {
  const members = String(pairName || '')
    .split(/[\/&+]/)
    .map(firstLastKey)
    .filter(Boolean)
    .sort();
  return members.join(' | ');
}

// Mapeia o título da prova na Sporttech para { disc, escaloes[], sexo, fase }
function classifyStageTitle(rawTitle) {
  const t = stripAccents(rawTitle);

  // 1. Disciplina
  let disc = 'TRI';
  if (/\bsyn\b|sincronizado|synchronised/.test(t)) disc = 'SYN';
  else if (/\bdmt\b|duplo/.test(t)) disc = 'DMT';
  else if (/\btum\b|tumbling/.test(t)) disc = 'TUM';

  // 2. Género
  let sexo = null;
  if (/\bmix\b|misto|mixed/.test(t)) sexo = 'Mix';
  else if (/\bfem\b|feminino|women|girls/.test(t)) sexo = 'F';
  else if (/\bmasc\b|masculino|men|boys/.test(t)) sexo = 'M';

  // 3. Escalão (regras específicas CN Portugal + Internacionais)
  // Nota: Jun Elite pode alimentar JUN e/ou 13-14 caso o ginasta faça apuramento nos dois
  let escaloes = [];
  if (/inic\s*1d|11-12|ag\s*1\b/.test(t)) {
    escaloes = ['11-12'];
  } else if (/juv\s*1d|13-14|ag\s*2\b/.test(t)) {
    escaloes = ['13-14'];
  } else if (/jun\s*elite|15-16|junior/.test(t)) {
    escaloes = ['JUN', '13-14'];
  } else if (/sen\s*1d|17-21|ag\s*4\b/.test(t)) {
    escaloes = ['17-21'];
  } else if (/sen\s*elite|senior|open/.test(t)) {
    escaloes = ['SEN'];
  }

  // 4. Fase (Q1, Q2, Final, Final 1, Final 2)
  let fase = 'q1';
  if (/final\s*2|\bf2\b/.test(t)) fase = 'f2';
  else if (/final\s*1|\bf1\b/.test(t)) fase = 'f1';
  else if (/\bfinal\b|\bfin\b/.test(t)) fase = 'f';
  else if (/\bq2\b|qual.*2|semi/.test(t)) fase = 'q2';

  return { disc, sexo, escaloes, fase, rawTitle };
}

// ============================================================================
// LEITURA DA API / HTML DA SPORTTECH
// ============================================================================
function extractEventId(url) {
  const m = String(url).match(/events\/([a-f0-9-]{36})/i);
  if (!m) throw new Error('URL da Sporttech inválido (UUID do evento não encontrado).');
  return m[1];
}

async function fetchJsonOrNull(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (RankingsTrampolins-LiveCheck)'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchSporttechStages(eventUrl) {
  const eventId = extractEventId(eventUrl);

  // Tenta os endpoints internos da plataforma Sporttech OVS
  const candidateEndpoints = [
    `https://sporttech.io/api/events/${eventId}/ovs`,
    `https://sporttech.io/api/events/${eventId}/stages`,
    `https://sporttech.io/events/${eventId}/ovs/data.json`
  ];

  for (const ep of candidateEndpoints) {
    const data = await fetchJsonOrNull(ep);
    if (data && (Array.isArray(data.stages) || Array.isArray(data.events) || Array.isArray(data))) {
      return normalizeApiPayload(eventId, data);
    }
  }

  // Fallback: analisa o HTML da página e extrai links de stages + JSON embutido
  const htmlRes = await fetch(eventUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (RankingsTrampolins-LiveCheck)' }
  });
  if (!htmlRes.ok) {
    throw new Error(`Erro HTTP ${htmlRes.status} ao aceder à Sporttech.`);
  }
  const html = await htmlRes.text();

  // Procura estado SSR / Next / Angular / JSON embutido no HTML
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      return normalizeApiPayload(eventId, parsed);
    } catch { /* continua */ }
  }

  // Extrai links para cada stage presentes no menu da página
  const stageRegex = /href="([^"]*\/events\/[^"]*\/ovs\/stage\/([^"?#]+)[^"]*)"[^>]*>([^<]+)</gi;
  const stageLinks = [];
  let match;
  while ((match = stageRegex.exec(html)) !== null) {
    const href = match[1].startsWith('http') ? match[1] : `https://sporttech.io${match[1]}`;
    const stageId = match[2];
    const title = match[3].replace(/\s+/g, ' ').trim();
    if (title && !stageLinks.some(s => s.stageId === stageId)) {
      stageLinks.push({ stageId, href, title });
    }
  }

  const results = [];
  for (const st of stageLinks) {
    const stJson = await fetchJsonOrNull(`https://sporttech.io/api/events/${eventId}/stages/${st.stageId}`);
    if (stJson) {
      results.push({
        id: st.stageId,
        title: st.title,
        entries: extractEntriesFromStageJson(stJson)
      });
    } else {
      const stHtmlRes = await fetch(st.href);
      const stHtml = stHtmlRes.ok ? await stHtmlRes.text() : '';
      results.push({
        id: st.stageId,
        title: st.title,
        entries: parseHtmlResultRows(stHtml)
      });
    }
  }

  return results;
}

function normalizeApiPayload(eventId, raw) {
  const list = Array.isArray(raw) ? raw : (raw.stages || raw.competitions || []);
  return list.map((st, idx) => ({
    id: String(st.id || st.stageId || idx),
    title: String(st.name || st.title || st.label || ''),
    entries: extractEntriesFromStageJson(st)
  }));
}

function extractEntriesFromStageJson(st) {
  const rows = st.results || st.entries || st.participants || st.startlist || [];
  return rows.map(r => {
    const num = (v) => {
      const n = parseFloat(String(v ?? '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    return {
      nome: String(r.name || r.athleteName || r.fullName || '').trim(),
      clube: cleanClub(r.club || r.team || r.noc || ''),
      filiado: String(r.license || r.federationId || r.nationalId || '').trim(),
      figId: String(r.figId || r.fig || '').trim(),
      e: num(r.e ?? r.execution),
      d: num(r.d ?? r.difficulty),
      hd: num(r.hd ?? r.horizontal),
      tof: num(r.tof ?? r.timeOfFlight),
      p: num(r.p ?? r.penalty) || 0,
      total: num(r.total ?? r.score ?? r.mark)
    };
  }).filter(e => e.nome);
}

function parseHtmlResultRows(html) {
  const entries = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(html)) !== null) {
    const cells = [];
    const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    }
    if (cells.length >= 3) {
      const nums = cells
        .map(c => parseFloat(c.replace(',', '.')))
        .filter(n => Number.isFinite(n) && n > 5 && n < 200);
      const total = nums.length ? nums[nums.length - 1] : null;
      const textCells = cells.filter(c => /[a-zA-ZÀ-ÿ]{3,}/.test(c));
      if (textCells.length >= 1) {
        entries.push({
          nome: textCells[0],
          clube: cleanClub(textCells[1] || ''),
          filiado: '',
          figId: '',
          e: null,
          d: null,
          hd: null,
          tof: null,
          p: 0,
          total
        });
      }
    }
  }
  return entries;
}

// ============================================================================
// MATCHING EM CASCATA E GERAÇÃO DE LOG
// ============================================================================
function matchAthleteToSporttech(ath, stageEntries) {
  const isSyn = ath.disc === 'SYN';

  // 1. Tenta por número de filiado (FGP)
  if (ath.filiado) {
    const byFil = stageEntries.find(e => e.filiado && e.filiado === String(ath.filiado).trim());
    if (byFil) return { entry: byFil, method: `Filiado (${ath.filiado})` };
  }

  // 2. Tenta por FIG ID
  if (ath.figId) {
    const byFig = stageEntries.find(e => e.figId && e.figId === String(ath.figId).trim());
    if (byFig) return { entry: byFig, method: `FIG ID (${ath.figId})` };
  }

  // 3. Tenta por Nome Normalizado (Primeiro + Último) + Clube
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
    const byClub = candidates.find(c => athClubs.includes(cleanClub(c.clube)));
    if (byClub) return { entry: byClub, method: `Nome + Clube (${byClub.clube})` };
    return { entry: candidates[0], method: 'Nome (ambíguo - 1.º encontrado)' };
  }

  return null;
}

async function runSync() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const athletes = JSON.parse(fs.readFileSync(CONFIG.athletesFile, 'utf8'));
  let resultsDoc = { live: true, atualizadoEm: nowStr, resultados: { [CONFIG.eventoId]: {} } };
  if (fs.existsSync(CONFIG.resultsFile)) {
    resultsDoc = JSON.parse(fs.readFileSync(CONFIG.resultsFile, 'utf8'));
  }
  resultsDoc.resultados = resultsDoc.resultados || {};
  resultsDoc.resultados[CONFIG.eventoId] = resultsDoc.resultados[CONFIG.eventoId] || {};

  const logLines = [
    `====================================================================`,
    `RELATÓRIO SPORTTECH (${IS_CHECK_ONLY ? 'VERIFICAÇÃO START LIST' : 'LIVE SYNC'}) — ${nowStr}`,
    `URL: ${CONFIG.sporttechUrl}`,
    `====================================================================`,
    ``
  ];

  let stages = [];
  try {
    stages = await fetchSporttechStages(CONFIG.sporttechUrl);
  } catch (err) {
    logLines.push(`[ERRO CRÍTICO] Falha ao contactar a Sporttech: ${err.message}`);
    fs.writeFileSync(CONFIG.logFile, logLines.join('\n'), 'utf8');
    console.error(logLines.join('\n'));
    return;
  }

  logLines.push(`Provas/Stages detetados na Sporttech: ${stages.length}`);
  const classifiedStages = stages.map(st => ({
    ...st,
    meta: classifyStageTitle(st.title)
  }));

  classifiedStages.forEach(st => {
    const m = st.meta;
    logLines.push(`  • [${st.id}] "${st.title}" -> ${m.disc} | Escalões: [${m.escaloes.join(', ') || '?'}] | Sexo: ${m.sexo || '?'} | Fase: ${m.fase} (${st.entries.length} inscritos)`);
  });
  logLines.push(``);

  let matchedCount = 0;
  let missingCount = 0;
  let updatedScores = 0;

  logLines.push(`--- CRUZAMENTO DE GINASTAS (${athletes.length} no JSON) ---`);

  for (const ath of athletes) {
    // Filtra os stages da Sporttech que correspondem à disciplina, género e escalão deste ginasta
    const relevantStages = classifiedStages.filter(st => {
      const m = st.meta;
      if (m.disc !== ath.disc) return false;
      if (m.sexo && m.sexo !== ath.sexo) return false;
      if (m.escaloes.length > 0 && !m.escaloes.includes(ath.escalao)) return false;
      return true;
    });

    if (relevantStages.length === 0) {
      missingCount++;
      logLines.push(`[ERRO - SEM PROVA] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube}) -> Nenhuma prova correspondente encontrada na Sporttech.`);
      continue;
    }

    let foundInAnyStage = false;
    const evRec = resultsDoc.resultados[CONFIG.eventoId][ath.id] || { rotinas: {} };
    evRec.rotinas = evRec.rotinas || {};

    for (const st of relevantStages) {
      const match = matchAthleteToSporttech(ath, st.entries);
      if (match) {
        foundInAnyStage = true;
        const e = match.entry;
        const faseKey = st.meta.fase;
        logLines.push(`[OK] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo}) -> Encontrado em "${st.title}" via ${match.method} | Total: ${e.total ?? 'sem nota'}`);

        if (!IS_CHECK_ONLY && e.total !== null) {
          evRec[faseKey] = e.total;
          evRec.rotinas[faseKey] = {
            e: e.e ?? 0,
            d: e.d ?? 0,
            hd: e.hd ?? 0,
            tof: e.tof ?? 0,
            p: e.p ?? 0,
            total: e.total
          };
          updatedScores++;
        }
      }
    }

    if (foundInAnyStage) {
      matchedCount++;
      if (!IS_CHECK_ONLY && Object.keys(evRec.rotinas).length > 0) {
        resultsDoc.resultados[CONFIG.eventoId][ath.id] = evRec;
      }
    } else {
      missingCount++;
      logLines.push(`[ERRO - NÃO ENCONTRADO] ${ath.nome} (${ath.disc} · ${ath.escalao} · ${ath.sexo} · ${ath.clube} | Filiado: ${ath.filiado || '—'} | FIG: ${ath.figId || '—'}) -> Não aparece nas listas de "${relevantStages.map(s => s.title).join(' / ')}".`);
    }
  }

  logLines.push(``);
  logLines.push(`RESUMO: ${matchedCount} encontrados | ${missingCount} com erro/não encontrados | ${updatedScores} notas atualizadas.`);

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
    console.log(`\nModo LIVE ativo: a verificar novamente a cada ${CONFIG.pollIntervalMs / 1000}s...`);
    setInterval(runSync, CONFIG.pollIntervalMs);
  }
})();
