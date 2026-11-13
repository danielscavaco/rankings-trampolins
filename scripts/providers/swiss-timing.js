'use strict';

const { cleanClub, normalizeSex, mapEscalaoText, fetchWithRetry, stripAccents } = require('../lib/core');

const pageCache = new Map();

function decodeHtml(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSwissDisc(text) {
  const s = stripAccents(text);
  if (/\bsynchro/.test(s)) return 'SYN';
  if (/\bdouble\s*mini|\bdmt\b/.test(s)) return 'DMT';
  if (/\btumbling|\btum\b/.test(s)) return 'TUM';
  if (/\btrampoline|\bindividual\b/.test(s)) return 'TRI';
  return null;
}

function parseSwissPhase(subtitleText, linkClass) {
  const s = stripAccents(`${subtitleText} ${linkClass}`);
  if (/\bqualification\s*2|\bq2\b/.test(s)) return 'q2';
  if (/\bqualification|\bq1\b/.test(s)) return 'q1';
  if (/\bfinal\s*2|\bf2\b/.test(s)) return 'f2';
  if (/\bfinal\s*1|\bf1\b/.test(s)) return 'f1';
  if (/\bfinal\b/.test(s)) return 'f';
  return 'q1';
}

function parseRoutineCell(cellHtml) {
  // O número principal antes de <small> é o total da rotina (ex: "29.000")
  const mainPart = cellHtml.split(/<small>/i)[0];
  const totalMatch = decodeHtml(mainPart).match(/(\d+\.\d+)/);
  if (!totalMatch) return null;

  const total = Number(parseFloat(totalMatch[1]).toFixed(3));
  if (!Number.isFinite(total) || total <= 0) return null;

  const detail = { e: 0, d: 0, hd: 0, tof: 0, p: 0, total };
  const judgeRegex = /<span class="judgescore">\s*([A-Za-z]+)\s*:\s*([0-9.]+)\s*<\/span>/gi;
  let m;
  while ((m = judgeRegex.exec(cellHtml)) !== null) {
    const label = m[1].toUpperCase();
    const val = Number(parseFloat(m[2]).toFixed(3));
    if (label === 'D') detail.d = val;
    else if (label === 'E') detail.e = val;
    else if (label === 'H' || label === 'HD') detail.hd = val;
    else if (label === 'T' || label === 'TOF' || label === 'S') detail.tof = val;
    else if (label === 'P' || label === 'PEN') detail.p = val;
  }

  return detail;
}

function parseRankingTable(html, isSyn) {
  const entries = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    if (!/<td\b/i.test(rowHtml)) continue;

    // Nome(s) completos dentro de <div class="fulldescription">
    const fullDescMatches = [...rowHtml.matchAll(/<div class="fulldescription">([\s\S]*?)<\/div>/gi)]
      .map(m => decodeHtml(m[1]))
      .filter(Boolean);

    if (fullDescMatches.length === 0) continue;

    // Swiss Timing coloca "APELIDO Nome" -> convertemos para "Nome APELIDO" ou mantemos ambos os tokens
    const formattedNames = fullDescMatches.map(rawName => {
      const parts = rawName.split(/\s+/);
      if (parts.length >= 2) {
        // Ex: "PESO Vasco" -> "Vasco PESO" (isSamePerson também funciona nos dois sentidos)
        return `${parts.slice(1).join(' ')} ${parts[0]}`;
      }
      return rawName;
    });

    const nome = isSyn ? formattedNames.join(' / ') : formattedNames[0];

    // País / Clube (<td class="noc">...POR</td>)
    const nocMatch = rowHtml.match(/<td class="noc"[^>]*>([\s\S]*?)<\/td>/i);
    const noc = nocMatch ? cleanClub(decodeHtml(nocMatch[1])) : '';

    // Colunas de exercícios (<td class="score ...">)
    const routines = [];
    const scoreCellRegex = /<td class="score\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    let scMatch;
    while ((scMatch = scoreCellRegex.exec(rowHtml)) !== null) {
      const parsed = parseRoutineCell(scMatch[1]);
      if (parsed) routines.push(parsed);
    }

    // Coluna Total (<td class="total">58.200</td>)
    const totalMatch = rowHtml.match(/<td class="total"[^>]*>([\s\S]*?)<\/td>/i);
    const totalVal = totalMatch ? parseFloat(decodeHtml(totalMatch[1])) : NaN;
    const total = Number.isFinite(totalVal) && totalVal > 0
      ? Number(totalVal.toFixed(3))
      : (routines.length > 0 ? Number(routines.reduce((acc, r) => acc + r.total, 0).toFixed(3)) : null);

    entries.push({
      nome,
      clubes: noc ? [noc] : [],
      filiados: [],
      figIds: [],
      total,
      routines
    });
  }

  return entries;
}

async function loadStages(competitionUrl, logLines) {
  const parsedUrl = new URL(competitionUrl);
  const origin = parsedUrl.origin;

  const scheduleHtml = await fetchWithRetry(competitionUrl, { accept: 'text/html' });

  // Descobre blocos <span class="subtitle">Título <div class="resultsicons"><a ... href="...">
  const subtitleRegex = /<span class="subtitle">([\s\S]*?)<\/span>/gi;
  const discoveredPhases = new Map();
  let subMatch;

  while ((subMatch = subtitleRegex.exec(scheduleHtml)) !== null) {
    const block = subMatch[1];
    const titleText = decodeHtml(block.split(/<div class="resultsicons"/i)[0]);
    if (!titleText || /team|all-around/i.test(titleText)) continue;

    // Procura links de Ranking/Results ou StartList
    const linkRegex = /<a\b([^>]*href="([^"]*\/Phase\/(?:Ranking|Results|StartList)\/[^"]+)"[^>]*)>/gi;
    let lk;
    while ((lk = linkRegex.exec(block)) !== null) {
      const attrs = lk[1];
      const href = lk[2];
      const classMatch = attrs.match(/class="([^"]*)"/i);
      const linkClass = classMatch ? classMatch[1] : '';

      // Prefere sempre Ranking/Results em relação a StartList para a mesma fase
      const phaseIdMatch = href.match(/\/Phase\/(?:Ranking|Results|StartList)\/([0-9A-Za-z]+)/i);
      const phaseKey = phaseIdMatch ? phaseIdMatch[1] : href;
      const isRanking = /\/Phase\/(?:Ranking|Results)\//i.test(href);

      const existing = discoveredPhases.get(phaseKey);
      if (!existing || isRanking) {
        discoveredPhases.set(phaseKey, {
          phaseId: phaseKey,
          title: titleText,
          linkClass,
          url: href.startsWith('http') ? href : `${origin}${href}`
        });
      }
    }
  }

  const stageList = [];

  for (const ph of discoveredPhases.values()) {
    const disc = parseSwissDisc(`${ph.title} ${ph.linkClass}`);
    if (!disc) continue;

    const sexo = normalizeSex(`${ph.title} ${ph.linkClass}`);
    const escaloes = mapEscalaoText(ph.title, { allowDefaultSenior: true });
    if (escaloes.length === 0) continue;

    const fase = parseSwissPhase(ph.title, ph.linkClass);
    const isSenOnly = escaloes.length === 1 && escaloes[0] === 'SEN';
    if (!isSenOnly && fase !== 'q1') continue;

    let phaseHtml;
    try {
      phaseHtml = await fetchWithRetry(ph.url, { accept: 'text/html' });
      pageCache.set(ph.phaseId, phaseHtml);
    } catch (err) {
      if (pageCache.has(ph.phaseId)) {
        phaseHtml = pageCache.get(ph.phaseId);
      } else {
        logLines.push(`[AVISO] Erro ao ler fase Swiss Timing "${ph.title}": ${err.message}`);
        continue;
      }
    }

    const entries = parseRankingTable(phaseHtml, disc === 'SYN');

    stageList.push({
      sid: ph.phaseId,
      title: ph.title,
      disc,
      sexo,
      escaloes,
      fase,
      entries
    });
  }

  return stageList;
}

module.exports = {
  name: 'Swiss Timing',
  loadStages
};
