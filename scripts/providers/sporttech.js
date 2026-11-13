'use strict';

const { cleanClub, normalizeSex, mapEscalaoText, fetchWithRetry } = require('../lib/core');

const DISC_MAP = { 0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM' };
const KIND_MAP = { 0: 'q1', 6: 'q2', 3: 'f', 8: 'f1', 7: 'f2' };
const stageCache = new Map();

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

async function loadStages(competitionUrl, logLines) {
  const apiBase = String(competitionUrl || '').replace(/\/+$/, '') + '/api/';
  const evData = await fetchWithRetry(apiBase + 'event?fetch_event_competitions=true&fetch_competition_stages=true');
  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};
  const stageList = [];

  for (const [, c] of Object.entries(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc) continue;
    const sexo = normalizeSex(c.SexCategory);
    const escaloes = mapEscalaoText(`${c.AgeGroup || ''} ${c.Title || ''}`, { allowDefaultSenior: true });
    if (escaloes.length === 0) continue;

    const isSenOnly = escaloes.length === 1 && escaloes[0] === 'SEN';

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);

      if (!isSenOnly && fase !== 'q1') continue;

      const cacheKey = `${st.LastEdit_G}|${st.FinishedFrames_G}|${st.InProgress_G}`;
      let det = stageCache.get(String(sid));
      if (!det || det.cacheKey !== cacheKey) {
        try {
          const rawDet = await fetchWithRetry(
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

module.exports = {
  name: 'Sporttech OVS',
  loadStages
};
