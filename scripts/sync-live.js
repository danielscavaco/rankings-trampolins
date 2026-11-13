#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { applyStagesToTarget } = require('./lib/core');

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

(async () => {
  await runSync();
  if (IS_LIVE_LOOP) {
    setInterval(runSync, POLL_INTERVAL_MS);
  }
})();
