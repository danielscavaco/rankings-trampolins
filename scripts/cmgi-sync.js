'use strict';

const fs = require('fs');
const { cleanClub, normalizeSex, fetchWithRetry } = require('./lib/core');

const DISC_MAP = { 0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM' };
const KIND_MAP = { 0: 'q1', 6: 'q2', 3: 'f', 8: 'f1', 7: 'f2' };
const OUT_FILE = 'data/temp-cmgi-results.json';

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

function isPortuguese(ath) {
  const vals = [ath.Club, ath.Team, ath.Representing, ath.Country, ath.Nation, ath.NOC]
    .map(v => String(v || '').trim().toUpperCase());
  return vals.some(v => v === 'POR' || v === 'PRT' || /^POR\b/.test(v));
}

async function resolveSporttechApi(rawUrl) {
  const uuidMatch = String(rawUrl || '').match(/events\/([0-9a-f-]{36})/i);
  if (!uuidMatch) throw new Error(`UUID do evento não encontrado em: ${rawUrl}`);
  const uuid = uuidMatch[1];

  const candidates = [
    `https://sporttech.io/events/${uuid}/ovs/api/`,
    `https://sporttech.io/events/${uuid}/livescore/api/`,
    `https://sporttech.io/api/events/${uuid}/`
  ];

  for (const base of candidates) {
    try {
      const data = await fetchWithRetry(`${base}event?fetch_event_competitions=true&fetch_competition_stages=true`);
      if (data && typeof data === 'object' && (data.Competitions || data.Stages || data.Id || data.Title)) {
        return { apiBase: base, evData: data };
      }
    } catch (_) {
      // Tenta o próximo formato de endpoint
    }
  }
  throw new Error(`Nenhum endpoint da Sporttech aceitou o evento ${uuid}.`);
}

(async () => {
  const { apiBase, evData } = await resolveSporttechApi(process.env.CMGI_URL);
  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};

  const athletesMap = new Map();

  for (const [, c] of Object.entries(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc || disc === 'SYN') continue; // Apenas TRA (TRI), DMT e TUM

    const sexo = normalizeSex(`${c.SexCategory || ''} ${c.Title || ''}`);
    const escalao = String(c.AgeGroup || c.Title || 'OPEN').trim();

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);

      const det = await fetchWithRetry(
        `${apiBase}stages/${sid}?fetch_stage_groups=true&fetch_group_performances=true&fetch_performance_athletes=true&fetch_performance_frames=true`
      );

      const A = det.Athletes || {};
      const P = det.Performances || {};
      const F = det.Frames || {};
      const lim = st.PerfomanceFramesLimit || 2;

      for (const p of Object.values(P)) {
        const athObjs = (p.Athletes || []).map(aid => A[String(aid)] || A[aid]).filter(Boolean);
        if (!athObjs.length || !athObjs.some(isPortuguese)) continue;

        const a = athObjs[0];
        const nome = `${a.GivenName || ''} ${a.Surname || ''}`.trim();
        const clube = cleanClub(a.Club || a.Team || a.Representing || 'POR');
        const key = `${disc}|${escalao}|${sexo}|${nome}`;

        if (!athletesMap.has(key)) {
          athletesMap.set(key, { nome, disc, escalao, sexo, clube, rotinas: {}, q1: null, f: null });
        }
        const rec = athletesMap.get(key);

        const routines = (p.Frames || []).slice(0, lim).map(fid => {
          const f = F[String(fid)] || F[fid];
          if (f && (f.State || 0) >= 3) {
            return parseFrameDetail(f);
          }
          return null;
        });

        const totalMk = (p.MarkTTT_G || 0) > 0 ? Number(((p.MarkTTT_G || 0) / 1000.0).toFixed(3)) : null;

        if (fase === 'q1') {
  if (totalMk !== null) rec.q1 = totalMk;
  if (routinesBySlot[0]) rec.rotinas.q1_1 = routinesBySlot[0];
  if (routinesBySlot[1]) rec.rotinas.q1_2 = routinesBySlot[1];
} else if (routinesBySlot[0]) {
  rec.rotinas[fase] = routinesBySlot[0];
  if (totalMk !== null) rec[fase] = totalMk;
}
      }
    }
  }

  const list = [...athletesMap.values()].sort((a, b) =>
    a.disc.localeCompare(b.disc) || a.escalao.localeCompare(b.escalao) || a.nome.localeCompare(b.nome, 'pt')
  );

  // Só atualiza o ficheiro se houver alteração real nos dados (evita commits vazios)
  let prevJson = '';
  if (fs.existsSync(OUT_FILE)) {
    try {
      prevJson = JSON.stringify(JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).atletas || []);
    } catch (_) {}
  }

  if (JSON.stringify(list) !== prevJson) {
    fs.writeFileSync(OUT_FILE, JSON.stringify({ atualizadoEm: new Date().toISOString(), atletas: list }, null, 2));
    console.log(`Atualizado: ${list.length} ginastas POR.`);
  } else {
    console.log(`Sem alterações (${list.length} ginastas POR).`);
  }
})();
