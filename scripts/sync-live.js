#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { applyStagesToTarget } = require('./lib/core');
const { spawnSync } = require('child_process');

const providers = {
  sporttech: require('./providers/sporttech'),
  'swiss-timing': require('./providers/swiss-timing')
};

const TARGETS_FILE = path.resolve(__dirname, 'live-targets.json');
const LOG_FILE = path.resolve(__dirname, 'scrape-report.log');
const ROOT_DIR = path.resolve(__dirname, '..');
const POLL_INTERVAL_MS = 10000;

const args = process.argv.slice(2);
const IS_CHECK_ONLY = args.includes('--check');
const IS_LIVE_LOOP = args.includes('--live');

function detectProvider(url, explicitProvider) {
  if (explicitProvider && providers[explicitProvider]) return explicitProvider;
  const u = String(url || '').toLowerCase();
  if (u.includes('longinestiming.com')) return 'swiss-timing';
  if (u.includes('sporttech.io')) return 'sporttech';
  if (u.includes('smartscoring.com')) return 'smartscoring';
  if (u.includes('acro-companion.com')) return 'acro-companion';
  return 'sporttech';
}

async function runSync() {
  const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const liveCfg = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
  const targets = liveCfg.targets || [];

  const logLines = [
    `====================================================================`,
    `RELATÓRIO LIVE SYNC MULTI-SISTEMA (${IS_CHECK_ONLY ? 'VERIFICAÇÃO START LIST' : 'LIVE SYNC'}) — ${nowStr}`,
    `Competições alvo: ${targets.map(t => t.nome).join(' | ')}`,
    `====================================================================`,
    ``
  ];

  // Evita ler a mesma URL duas vezes no mesmo ciclo se vários targets partilharem a mesma prova
  const urlStageCache = new Map();

  for (const target of targets) {
    const compUrl = target.url || liveCfg.sporttechUrl;
    const providerKey = detectProvider(compUrl, target.provider);
    const adapter = providers[providerKey];

    if (!adapter) {
      logLines.push(`[ERRO] Sistema "${providerKey}" ainda não implementado para "${target.nome}" (${compUrl}).`);
      continue;
    }

    let stageList;
    const cacheKey = `${providerKey}::${compUrl}`;
    if (urlStageCache.has(cacheKey)) {
      stageList = urlStageCache.get(cacheKey);
    } else {
      try {
        logLines.push(`Fonte [${adapter.name}]: ${compUrl}`);
        stageList = await adapter.loadStages(compUrl, logLines);
        urlStageCache.set(cacheKey, stageList);

        logLines.push(`Stages carregados (${adapter.name}): ${stageList.length}`);
        stageList.forEach(st => {
          logLines.push(`  • [${st.sid}] ${st.title} -> ${st.disc} | Escalões: [${st.escaloes.join(', ')}] | Sexo: ${st.sexo} | Fase: ${st.fase} (${st.entries.length} atletas)`);
        });
      } catch (err) {
        logLines.push(`[ERRO CRÍTICO] Falha ao ler ${adapter.name} (${compUrl}): ${err.message}`);
        continue;
      }
    }

    applyStagesToTarget({
      target,
      stageList,
      nowStr,
      isCheckOnly: IS_CHECK_ONLY,
      logLines,
      rootDir: ROOT_DIR
    });
  }

  fs.writeFileSync(LOG_FILE, logLines.join('\n'), 'utf8');
  console.log(logLines.join('\n'));
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    throw new Error(`Erro Git: ${args.join(' ')}`);
  }
}

function publishResults() {
  const liveCfg = JSON.parse(
    fs.readFileSync(TARGETS_FILE, 'utf8')
  );

  const resultFiles = [
    ...new Set((liveCfg.targets || []).map(t => t.resultsFile))
  ];

  // Publicar apenas os ficheiros de resultados
  runGit(['add', '--', ...resultFiles]);

  const diff = spawnSync('git', ['diff', '--cached', '--quiet']);

  if (diff.status === 0) {
    console.log('[GIT] Sem alterações nos resultados.');
    return;
  }

  if (diff.status !== 1) {
    throw new Error('Não foi possível verificar as alterações Git.');
  }

  runGit([
    'commit',
    '-m',
    'Live update resultados [skip ci]'
  ]);

  const push = spawnSync('git', ['push'], {
    encoding: 'utf8',
    stdio: 'inherit'
  });

  if (push.status !== 0) {
    console.log('[GIT] Push falhou. A tentar sincronizar...');

    runGit(['pull', '--rebase', '-X', 'theirs']);
    runGit(['push']);
  }

  console.log('[GIT] Resultados publicados.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEventState() {
  const liveCfg = JSON.parse(
    fs.readFileSync(TARGETS_FILE, 'utf8')
  );

  const now = Date.now();
  let anyRunning = false;
  let anyPending = false;

  for (const target of (liveCfg.targets || [])) {
    const cfg = JSON.parse(
      fs.readFileSync(target.configFile, 'utf8')
    );

    const ev = (cfg.eventos || []).find(
      e => e.id === target.eventoId
    ) || (cfg.eventos || [])[0];

    if (!ev) continue;

    const start = Date.parse(
      (ev.inicio || '2000-01-01') + 'T00:00:00' + (ev.tz || '+14:00')
    );

    const end = Date.parse(
      (ev.fim || '2099-12-31') + 'T23:59:59' + (ev.tz || '-12:00')
    );

    if (now >= start && now <= end) anyRunning = true;
    if (now <= end) anyPending = true;
  }

  return anyRunning ? 'running' : (anyPending ? 'waiting' : 'ended');
}

async function runLiveLoop() {
  const startTime = Date.now();
  const maxDuration = 12600 * 1000; // 3h30

  console.log('[LIVE] Início do ciclo contínuo.');

  while (Date.now() - startTime < maxDuration) {
    const state = getEventState();

    if (state === 'ended') {
      console.log('[LIVE] Todos os eventos terminaram.');
      break;
    }

    if (state === 'waiting') {
      console.log('[LIVE] À espera do início da competição.');
      await sleep(60000);
      continue;
    }

    const cycleStart = Date.now();

    await runSync();
    publishResults();

    const elapsed = Date.now() - cycleStart;

    console.log(`[LIVE] Ciclo concluído em ${(elapsed / 1000).toFixed(2)} s.`);

    await sleep(POLL_INTERVAL_MS);
  }

  console.log('[LIVE] Turno concluído.');
}

(async () => {
  try {
    if (IS_LIVE_LOOP) {
      await runLiveLoop();
    } else {
      await runSync();
    }
  } catch (err) {
    console.error('[FATAL]', err);
    process.exitCode = 1;
  }
})();
