'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const EVENT_URL = process.env.CMGI_URL || 'https://sporttech.io/events/01a1be6a-b476-781a-a380-de9079956fde/ovs/';
const OUT_FILE = 'data/temp-cmgi-results.json';
const INTERVAL_MS = 3000; // 3 segundos

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

  const out = { e: 0, d: Number(D.toFixed(3)), hd: 0, tof: 0, p: Number(P.toFixed(3)), total: Number(T.toFixed(3)) };
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
  const fields = [ath.Club, ath.Team, ath.Representing, ath.Country, ath.Nation, ath.NOC]
    .map(v => String(v || '').trim().toUpperCase());
  return fields.some(v => v === 'POR' || v === 'PRT' || /^POR\b/.test(v));
}

function normSex(s) {
  const v = String(s || '').toLowerCase();
  if (v.includes('mix')) return 'Mix';
  if (v.includes('fem') || v.includes('wom') || v === 'f') return 'F';
  return 'M';
}

async function syncCycle(lastSnapshot) {
  const apiBase = EVENT_URL.replace(/\/+$/, '') + '/api/';
  const evRes = await fetch(apiBase + 'event?fetch_event_competitions=true&fetch_competition_stages=true');
  const evData = await evRes.json();
  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};

  const athletesMap = new Map();

  for (const [, c] of Object.entries(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc || disc === 'SYN') continue; // Apenas TRA, DMT e TUM

    const sexo = normSex(`${c.SexCategory || ''} ${c.Title || ''}`);
    const escalao = String(c.AgeGroup || c.Title || 'OPEN').trim();

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);

      const cacheKey = `${st.LastEdit_G}|${st.FinishedFrames_G}|${st.InProgress_G}`;
      let det = stageCache.get(String(sid));
      if (!det || det.cacheKey !== cacheKey) {
        const sRes = await fetch(`${apiBase}stages/${sid}?fetch_stage_groups=true&fetch_group_performances=true&fetch_performance_athletes=true&fetch_performance_frames=true`);
        det = { cacheKey, data: await sRes.json() };
        stageCache.set(String(sid), det);
      }

      const A = det.data.Athletes || {};
      const P = det.data.Performances || {};
      const F = det.data.Frames || {};
      const lim = st.PerfomanceFramesLimit || 2;

      for (const p of Object.values(P)) {
        const athObjs = (p.Athletes || []).map(aid => A[String(aid)] || A[aid]).filter(Boolean);
        if (!athObjs.length || !athObjs.some(isPortuguese)) continue;

        const a = athObjs[0];
        const nome = `${a.GivenName || ''} ${a.Surname || ''}`.trim();
        const clube = String(a.Club || a.Team || 'POR').trim();
        const key = `${disc}|${escalao}|${sexo}|${nome}`;

        if (!athletesMap.has(key)) {
          athletesMap.set(key, { nome, disc, escalao, sexo, clube, rotinas: {}, q1: null, f: null });
        }
        const rec = athletesMap.get(key);

        const routines = [];
        for (const fid of (p.Frames || []).slice(0, lim)) {
          const f = F[String(fid)] || F[fid];
          if (f && (f.MarkTTT_G || 0) > 0 && (f.State || 0) >= 3) {
            routines.push(parseFrameDetail(f));
          }
        }

        const totalMk = (p.MarkTTT_G || 0) > 0 ? Number(((p.MarkTTT_G || 0) / 1000.0).toFixed(3)) : null;

        if (fase === 'q1') {
          if (totalMk !== null) rec.q1 = totalMk;
          if (routines[0]) rec.rotinas.q1_1 = routines[0];
          if (routines[1]) rec.rotinas.q1_2 = routines[1];
        } else if (routines[0]) {
          rec.rotinas[fase] = routines[0];
          if (totalMk !== null) rec[fase] = totalMk;
        }
      }
    }
  }

  const list = [...athletesMap.values()].sort((a, b) =>
    a.disc.localeCompare(b.disc) || a.escalao.localeCompare(b.escalao) || a.nome.localeCompare(b.nome, 'pt')
  );

  const payload = JSON.stringify(list);
  if (payload !== lastSnapshot) {
    fs.writeFileSync(OUT_FILE, JSON.stringify({ atualizadoEm: new Date().toISOString(), atletas: list }, null, 2));
    try {
      execSync(`git config user.name "github-actions[bot]" && git config user.email "github-actions[bot]@users.noreply.github.com" && git add ${OUT_FILE} && git commit -m "Live CMGI update" && git push`, { stdio: 'ignore' });
      console.log(`[${new Date().toISOString()}] Atualizado e enviado (${list.length} ginastas POR)`);
    } catch (_) {}
  }
  return payload;
}

(async () => {
  let snap = '';
  const end = Date.now() + 5.5 * 3600 * 1000;
  while (Date.now() < end) {
    try { snap = await syncCycle(snap); } catch (e) { console.error(e.message); }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();
