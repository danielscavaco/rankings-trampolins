'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { cleanClub, normalizeSex, fetchWithRetry } = require('./lib/core');

const DISC_MAP = { 0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM' };
const KIND_MAP = { 0: 'q1', 6: 'q2', 3: 'f', 8: 'f1', 7: 'f2' };
const OUT_FILE = 'data/temp-cmgi-results.json';

const POLL_MS = Number(process.env.POLL_MS || 10000);         // Lê Sporttech a cada 10s
const MIN_COMMIT_MS = Number(process.env.MIN_COMMIT_MS || 15000); // Intervalo mínimo entre commits (15s)
const BUDGET_MS = Number(process.env.BUDGET_MS || 18000000);  // 5 horas por execução
const SINGLE_RUN = process.env.SINGLE_RUN === 'true';

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

function isValidCompletedFrame(f) {
  if (!f || (f.State || 0) !== 3) return false;
  const log = String(f.ChangeLog || '');
  // Ignora registos de DNS / não iniciado ("Fail" / "DNS" no ChangeLog sem elementos nem pontuação)
  if (/\b(fail|dns)\b/i.test(log) && (f.MarkTTT_G || 0) === 0 && !f.DifficultyElements) {
    return false;
  }
  return true;
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
        return base;
      }
    } catch (_) {}
  }
  throw new Error(`Nenhum endpoint da Sporttech aceitou o evento ${uuid}.`);
}

function git(...args) {
  try {
    execFileSync('git', args, { stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

function commitAndPush() {
  git('add', OUT_FILE);
  if (git('diff', '--cached', '--quiet')) return true;
  git('commit', '-m', 'Live CMGI: atualização automática (Sporttech)');

  for (let i = 0; i < 4; i++) {
    if (git('push')) return true;
    git('pull', '--rebase', '-X', 'theirs');
  }
  console.error('[AVISO] Falha ao fazer git push.');
  return false;
}

const stageCache = new Map();

async function pollOnce(apiBase) {
  const evData = await fetchWithRetry(`${apiBase}event?fetch_event_competitions=true&fetch_competition_stages=true`);
  const comps = evData.Competitions || {};
  const stages = evData.Stages || {};
  const athletesMap = new Map();

  for (const c of Object.values(comps)) {
    if ((c.Title || '').toLowerCase() === 'test') continue;
    const disc = DISC_MAP[c.Discipline];
    if (!disc || disc === 'SYN') continue;

    const sexo = normalizeSex(`${c.SexCategory || ''} ${c.Title || ''}`);
    const escalao = String(c.AgeGroup || c.Title || 'OPEN').trim();

    for (const sid of (c.Stages || [])) {
      const st = stages[String(sid)] || stages[sid];
      if (!st) continue;
      const fase = KIND_MAP[st.Kind] || String(st.Kind);

      const cacheKey = `${st.LastEdit_G}|${st.FinishedFrames_G}|${st.InProgress_G}`;
      let det = stageCache.get(String(sid));
      if (!det || det.cacheKey !== cacheKey) {
        const rawDet = await fetchWithRetry(
          `${apiBase}stages/${sid}?fetch_stage_groups=true&fetch_group_performances=true&fetch_performance_athletes=true&fetch_performance_frames=true`
        );
        det = { cacheKey, data: rawDet };
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
        const clube = cleanClub(a.Club || a.Team || a.Representing || 'POR');
        const key = `${disc}|${escalao}|${sexo}|${nome}`;

        if (!athletesMap.has(key)) {
          athletesMap.set(key, { nome, disc, escalao, sexo, clube, rotinas: {}, q1: null, f: null });
        }
        const rec = athletesMap.get(key);

        const routines = (p.Frames || []).slice(0, lim).map(fid => {
          const f = F[String(fid)] || F[fid];
          return isValidCompletedFrame(f) ? parseFrameDetail(f) : null;
        });

        const totalMk = (p.MarkTTT_G || 0) > 0 ? Number(((p.MarkTTT_G || 0) / 1000.0).toFixed(3)) : null;

        if (fase === 'q1') {
          if (totalMk !== null) rec.q1 = totalMk;
          if (routines[0]) rec.rotinas.q1_1 = routines[0];
          if (routines[1]) rec.rotinas.q1_2 = routines[1];
        } else {
          const firstCompleted = routines.find(Boolean);
          if (firstCompleted) {
            rec.rotinas[fase] = firstCompleted;
            if (totalMk !== null) rec[fase] = totalMk;
          }
        }
      }
    }
  }

  return [...athletesMap.values()].sort((a, b) =>
    a.disc.localeCompare(b.disc) || a.escalao.localeCompare(b.escalao) || a.nome.localeCompare(b.nome, 'pt')
  );
}

(async () => {
  const startTime = Date.now();
  git('config', 'user.name', 'CMGI Live Sync');
  git('config', 'user.email', 'actions@users.noreply.github.com');

  const apiBase = await resolveSporttechApi(process.env.CMGI_URL);

  let prevJson = '';
  if (fs.existsSync(OUT_FILE)) {
    try {
      prevJson = JSON.stringify(JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).atletas || []);
    } catch (_) {}
  }

  let lastCommitTime = 0;

  while (true) {
    try {
      const list = await pollOnce(apiBase);
      const currJson = JSON.stringify(list);

      if (currJson !== prevJson && (Date.now() - lastCommitTime >= MIN_COMMIT_MS || SINGLE_RUN)) {
        fs.mkdirSync('data', { recursive: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify({ atualizadoEm: new Date().toISOString(), atletas: list }));
        if (commitAndPush()) {
          prevJson = currJson;
          lastCommitTime = Date.now();
          console.log(`[${new Date().toISOString()}] Atualizado: ${list.length} ginastas POR.`);
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Erro no ciclo:`, err.message);
    }

    if (SINGLE_RUN || (Date.now() - startTime >= BUDGET_MS)) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
