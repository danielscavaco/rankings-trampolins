'use strict';

const { cleanClub, normalizeSex, mapEscalaoText, stripAccents } = require('../lib/core');

const pageCache = new Map();

function decodeHtml(str) {
  return String(str || '')
    .replace(/&#x27;/gi, "'")
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
  if (/\bsynchro|\bsyn\b/.test(s)) return 'SYN';
  if (/\bdouble\s*mini|\bdmt\b/.test(s)) return 'DMT';
  if (/\btumbling|\btum\b/.test(s)) return 'TUM';
  if (/\btrampoline|\bindividual|\btra\b|\btri\b/.test(s)) return 'TRI';
  return null;
}

function parseSwissPhase(subtitleText, linkClass) {
  const s = stripAccents(`${subtitleText} ${linkClass}`);
  if (/\ball[\s-]*around/.test(s)) return 'aa';
  if (/\bteam\s*final|\bteam\b/.test(s)) return 'tf';
  if (/\bqualification\s*round\s*2|\bqualification\s*2|\bq2\b/.test(s)) return 'q2';
  if (/\bqualification|\bq1\b/.test(s)) return 'q1';
  if (/\bfinal\s*2|\bf2\b/.test(s)) return 'f2';
  if (/\bfinal\s*1|\bf1\b/.test(s)) return 'f1';
  if (/\bfinal\b/.test(s)) return 'f';
  return 'q1';
}

function parseRoutineCell(cellHtml) {
  const mainPart = cellHtml.split(/<small>/i)[0];
  const totalMatch = decodeHtml(mainPart).match(/(\d+\.\d+)/);
  if (!totalMatch) return null;

  const total = Number(parseFloat(totalMatch[1]).toFixed(3));
  if (!Number.isFinite(total) || total <= 0) return null;

  const detail = { e: 0, d: 0, hd: 0, tof: 0, p: 0, total };
  const judgeRegex = /<span[^>]*class="[^"]*judgescore[^"]*"[^>]*>\s*([A-Za-z]+)\s*:\s*([0-9.]+)\s*<\/span>/gi;
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

    let rawNames = [...rowHtml.matchAll(/<div[^>]*class="[^"]*fulldescription[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
      .map(m => decodeHtml(m[1]))
      .filter(Boolean);

    if (rawNames.length === 0) {
      const nameTd = rowHtml.match(/<td[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      if (nameTd) {
        const cleaned = decodeHtml(nameTd[1]);
        if (cleaned && !/^name$/i.test(cleaned)) rawNames = [cleaned];
      }
    }

    if (rawNames.length === 0) continue;

    // Converte "APELIDO Nome" -> "Nome APELIDO"
    const formattedNames = rawNames.map(rawName => {
      const parts = rawName.split(/\s+/);
      if (parts.length >= 2) {
        return `${parts.slice(1).join(' ')} ${parts[0]}`;
      }
      return rawName;
    });

    const nome = isSyn ? formattedNames.join(' / ') : formattedNames[0];

    const nocMatch = rowHtml.match(/<td[^>]*class="[^"]*\bnoc\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const noc = nocMatch ? cleanClub(decodeHtml(nocMatch[1])) : '';

    const routines = [];
    const scoreCellRegex = /<td[^>]*class="[^"]*\bscore\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    let scMatch;
    while ((scMatch = scoreCellRegex.exec(rowHtml)) !== null) {
      const parsed = parseRoutineCell(scMatch[1]);
      if (parsed) routines.push(parsed);
    }

    const totalMatch = rowHtml.match(/<td[^>]*class="[^"]*\btotal\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const totalVal = totalMatch ? parseFloat(decodeHtml(totalMatch[1])) : NaN;
    const total = Number.isFinite(totalVal) && totalVal > 0
      ? Number(totalVal.toFixed(3))
      : (routines.length > 0 ? Number(routines.reduce((acc, r) => acc + r.total, 0).toFixed(3)) : null);

    // Ignora linhas de resumo/total da equipa que não pertencem a um atleta
    if (routines.length === 0 && total === null) continue;

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

async function fetchSwissHtml(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === 2) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function loadStages(competitionUrl, logLines) {
  const parsedUrl = new URL(competitionUrl);
  const origin = parsedUrl.origin;

  const scheduleHtml = await fetchSwissHtml(competitionUrl);

  const subtitleRegex = /<span[^>]*class="[^"]*subtitle[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
  const discoveredPhases = new Map();
  let subMatch;

  while ((subMatch = subtitleRegex.exec(scheduleHtml)) !== null) {
    const block = subMatch[1];
    const titleText = decodeHtml(block.split(/<div[^>]*class="[^"]*resultsicons[^"]*"/i)[0]);
    if (!titleText) continue;

    const linkRegex = /<a\b([^>]*href="([^"]*\/Phase\/(?:Ranking|Results|StartList)\/[^"]+)"[^>]*)>/gi;
    let lk;
    while ((lk = linkRegex.exec(block)) !== null) {
      const attrs = lk[1];
      const href = lk[2];
      const classMatch = attrs.match(/class="([^"]*)"/i);
      const linkClass = classMatch ? classMatch[1] : '';

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
      phaseHtml = await fetchSwissHtml(ph.url);
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

    if (entries.length === 0 && stageList.length === 0) {
      const sample = phaseHtml.replace(/\s+/g, ' ').slice(0, 220);
      logLines.push(`[DEBUG Swiss Timing] HTML recebido em ${ph.url} (${phaseHtml.length} bytes): ${sample}`);
    }

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
