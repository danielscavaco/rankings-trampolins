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

  const detail = extractJudgeScores(cellHtml);
  detail.total = total;
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

    // Células de exercícios múltiplos (ex: Qualification com E1 e E2, que contêm <small> ou class="Score")
    let routines = [];
    const scoreCellRegex = /<td[^>]*class="[^"]*\bscore\b[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
    const rawScoreCells = [];
    let scMatch;
    while ((scMatch = scoreCellRegex.exec(rowHtml)) !== null) {
      rawScoreCells.push(scMatch[1]);
    }

    // Coluna Total (<td class="...total...">)
    const totalMatch = rowHtml.match(/<td[^>]*class="[^"]*\btotal\b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const totalVal = totalMatch ? parseFloat(decodeHtml(totalMatch[1])) : NaN;
    const total = Number.isFinite(totalVal) && totalVal > 0 ? Number(totalVal.toFixed(3)) : null;

    // Se as células tiverem <small> (ex: Q1 com Exercise 1 e Exercise 2), cada célula é uma rotina distinta
    const hasSubScores = rawScoreCells.some(c => /<small>/i.test(c));
    if (hasSubScores) {
      for (const cell of rawScoreCells) {
        const parsed = parseRoutineCell(cell);
        if (parsed) routines.push(parsed);
      }
    } else if (total !== null) {
      // Fase de 1 só rotina (Q2, TF, AA, F1, F2, F): o total da rotina é o <td class="total">
      const singleDetail = extractJudgeScores(rowHtml);
      singleDetail.total = total;
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
