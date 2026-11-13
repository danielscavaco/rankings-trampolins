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

function extractJudgeScoresFromText(rawHtml) {
  const detail = { e: 0, d: 0, hd: 0, tof: 0, p: 0, total: 0 };
  const cleaned = String(rawHtml || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const pairRegex = /\b(D|E|HD|H|TOF|T|F|S|PEN|P)\s*:\s*([0-9]+(?:\.[0-9]+)?)/gi;
  let m;
  while ((m = pairRegex.exec(cleaned)) !== null) {
    const label = m[1].toUpperCase();
    const val = Number(parseFloat(m[2]).toFixed(3));
    if (label === 'D') detail.d = val;
    else if (label === 'E') detail.e = val;
    else if (label === 'H' || label === 'HD') detail.hd = val;
    else if (label === 'T' || label === 'TOF' || label === 'F' || label === 'S') detail.tof = val;
    else if (label === 'P' || label === 'PEN') detail.p = val;
  }
  return detail;
}

function parseRoutineCell(cellHtml) {
  const mainPart = cellHtml.split(/<small>/i)[0];
  const totalMatch = decodeHtml(mainPart).match(/(\d+\.\d+)/);
  if (!totalMatch) return null;

  const total = Number(parseFloat(totalMatch[1]).toFixed(3));
  if (!Number.isFinite(total) || total <= 0) return null;

  const smallMatch = cellHtml.match(/<small>([\s\S]*?)<\/small>/i);
  const detail = extractJudgeScoresFromText(smallMatch ? smallMatch[1] : cellHtml);
  detail.total = total;
  return detail;
}

function parseHeaderColumns(html) {
  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (!theadMatch) return [];
  const cells = [...theadMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)];
  return cells.map(c => {
    const small = c[1].match(/<div[^>]*class="[^"]*smalldescription[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    return decodeHtml(small ? small[1] : c[1]).toUpperCase();
  });
}

function parseRankingTable(html, isSyn) {
  const entries = [];
  const headers = parseHeaderColumns(html);
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

    const allTds = [...rowHtml.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    const scoreCells = allTds
      .filter(td => /\bscore\b/i.test(td[1]))
      .map(td => td[2]);

    const totalMatch = rowHtml.match(/<td[^>]*class="[^"]*\btotal\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const totalVal = totalMatch ? parseFloat(decodeHtml(totalMatch[1])) : NaN;
    const total = Number.isFinite(totalVal) && totalVal > 0 ? Number(totalVal.toFixed(3)) : null;

    let routines = [];
    const hasSubScores = scoreCells.some(c => /<small>/i.test(c));

    if (hasSubScores) {
      for (const cell of scoreCells) {
        const parsed = parseRoutineCell(cell);
        if (parsed) routines.push(parsed);
      }
    } else if (total !== null) {
      const singleDetail = extractJudgeScoresFromText(rowHtml);
      singleDetail.total = total;

      if (headers.length === allTds.length) {
        allTds.forEach((td, idx) => {
          const h = headers[idx];
          const numMatch = decodeHtml(td[2]).match(/^([0-9]+(?:\.[0-9]+)?)$/);
          if (!numMatch) return;
          const val = Number(parseFloat(numMatch[1]).toFixed(3));
          if (h === 'D' || h === 'DIFF') singleDetail.d = val;
          else if (h === 'E' || h === 'EXEC') singleDetail.e = val;
          else if (h === 'H' || h === 'HD' || h === 'DISP') singleDetail.hd = val;
          else if (h === 'T' || h === 'TOF' || h === 'F' || h === 'FLIGHT' || h === 'TIME' || h === 'S' || h === 'SYNC') singleDetail.tof = val;
          else if (h === 'P' || h === 'PEN') singleDetail.p = val;
        });
      }

      routines = [singleDetail];
    }

    const finalTotal = total !== null
      ? total
      : (routines.length > 0 ? Number(routines.reduce((acc, r) => acc + r.total, 0).toFixed(3)) : null);

    if (routines.length === 0 && finalTotal === null) continue;

    entries.push({
      nome,
      clubes: noc ? [noc] : [],
      filiados: [],
      figIds: [],
      total: finalTotal,
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
