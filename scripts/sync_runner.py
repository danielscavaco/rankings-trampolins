#!/usr/bin/env python3
import argparse
import datetime as dt
import gzip
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.request
from zoneinfo import ZoneInfo

KIND_MAP = {0: 'Q', 6: 'Q2', 3: 'F', 8: 'F1', 7: 'F2'}
DISC_MAP = {0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM'}
BASE_LONGINES = 'https://gym.longinestiming.com'


def get_bytes(url, referer=None, retries=2, timeout=12):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip',
    }
    if referer:
        headers['Referer'] = referer
    for i in range(retries):
        try:
            rq = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(rq, timeout=timeout) as r:
                b = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    b = gzip.decompress(b)
                return b
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def get_json(url, referer=None, retries=2):
    return json.loads(get_bytes(url, referer=referer, retries=retries).decode('utf-8'))


def norm_tokens(s):
    x = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return [t for t in re.split(r'[^a-z]+', x) if t]


def match_athlete(athletes, raw_name, disc, sex):
    toks = norm_tokens(raw_name)
    if len(toks) < 2:
        return None
    for a in athletes:
        if a.get('disc') != disc or a.get('sexo') != sex:
            continue
        cand = norm_tokens(a.get('nome'))
        if not cand:
            continue
        if cand == toks:
            return a
        if cand[0] in toks and cand[-1] in toks:
            return a
    return None


def frame_detail(f):
    T = round((f.get('MarkTTT_G') or 0) / 1000.0, 3)
    E = f.get('ETotalT_G') or 0
    D = f.get('DifficultyT_G') or 0
    H = f.get('Displacement_G') or 0
    X = f.get('TimeTMS_G') or 0
    P = round((f.get('PenaltyT') or 0) / 10.0, 3)
    B = round((f.get('BonusT') or 0) / 10.0, 3)

    d_val = round(D / 10.0, 3)
    out = {'d': d_val, 'p': P, 'total': T}
    if B:
        out['b'] = B

    for e in (E / 10.0, E / 1000.0, E / 100.0):
        for h in (H / 100.0, H / 10.0, H / 1000.0):
            for x in (X / 1000.0, X * 2 / 100.0, X / 100.0, X / 10.0):
                if abs(e + d_val + h + x + B - P - T) < 0.006:
                    out['e'] = round(e, 3)
                    if H or X:
                        out['hd'] = round(h, 3)
                        out['tof'] = round(x, 3)
                    return out
    return out


def normalize_sex(raw_sex):
    s = str(raw_sex or '').lower()
    if s in ('female', 'f', 'w', 'women', '2'):
        return 'F'
    if s in ('male', 'm', 'men', '1'):
        return 'M'
    return None


def is_senior(age_group):
    ag = str(age_group or '').upper()
    if not ag:
        return True
    return ag in ('SEN', 'SENIOR', 'OPEN', '17+', '18+', 'ADULT')


def fetch_sporttech(uuid, athletes, minimos, national_mode=False):
    base_api = f'https://sporttech.io/events/{uuid}/ovs/api/'
    ev = get_json(base_api + 'event?fetch_event_competitions=true&fetch_competition_stages=true')
    comps = ev.get('Competitions') or {}
    stages = ev.get('Stages') or {}

    any_live = False
    event_records = {}

    for cid, c in comps.items():
        if (c.get('Title') or '').lower() == 'test':
            continue
        disc = DISC_MAP.get(c.get('Discipline'))
        if disc not in ('TRI', 'DMT', 'TUM'):
            continue
        if not national_mode and not is_senior(c.get('AgeGroup')):
            continue
        sex = normalize_sex(c.get('SexCategory'))
        if not sex:
            continue

        for sid in c.get('Stages') or []:
            st = stages.get(str(sid)) or stages.get(sid)
            if not st:
                continue
            if st.get('InProgress_G'):
                any_live = True

            kind = KIND_MAP.get(st.get('Kind'), str(st.get('Kind')))
            lim = st.get('PerfomanceFramesLimit') or 2

            det = get_json(
                f'{base_api}stages/{sid}?fetch_stage_groups=true&fetch_group_performances=true'
                f'&fetch_performance_athletes=true&fetch_performance_frames=true'
            )
            A = det.get('Athletes') or {}
            P = det.get('Performances') or {}
            F = det.get('Frames') or {}

            for p in P.values():
                ath_objs = [A.get(str(a)) or A.get(a) for a in (p.get('Athletes') or [])]
                ath_objs = [a for a in ath_objs if a]
                if not ath_objs:
                    continue

                if not national_mode:
                    if not any(str(a.get('Representing') or '').upper() == 'POR' for a in ath_objs):
                        continue

                a0 = ath_objs[0]
                full_name = f"{a0.get('GivenName', '')} {a0.get('Surname', '')}"
                ath = match_athlete(athletes, full_name, disc, sex)
                if not ath:
                    continue

                frames = []
                for fid in (p.get('Frames') or [])[:lim]:
                    f = F.get(str(fid)) or F.get(fid)
                    if not f:
                        continue
                    mk = f.get('MarkTTT_G') or 0
                    if mk > 0 and f.get('State', 0) >= 3:
                        frames.append(frame_detail(f))

                perf_mk = round((p.get('MarkTTT_G') or 0) / 1000.0, 3) if (p.get('MarkTTT_G') or 0) > 0 else None
                if not frames and perf_mk is None:
                    continue

                rec = event_records.setdefault(ath['id'], {'rotinas': {}})

                if disc == 'TRI':
                    if kind == 'Q':
                        if len(frames) >= 1:
                            rec['rotinas']['q1_1'] = frames[0]
                        if len(frames) >= 2:
                            rec['rotinas']['q1_2'] = frames[1]
                        if frames:
                            best_f = max(frames, key=lambda x: x['total'])
                            rec['q1'] = best_f['total']
                            rec['rotinas']['q1'] = best_f
                        elif perf_mk is not None:
                            rec['q1'] = perf_mk
                            rec['rotinas']['q1'] = {'total': perf_mk}
                    elif kind == 'Q2':
                        rt = frames[0] if frames else {'total': perf_mk}
                        rec['q2'] = rt['total']
                        rec['rotinas']['q2'] = rt
                    elif kind in ('F', 'F1'):
                        rt = frames[0] if frames else {'total': perf_mk}
                        rec['f'] = rt['total']
                        rec['rotinas']['f'] = rt
                else:
                    if kind == 'Q':
                        if len(frames) >= 1:
                            rec['rotinas']['q1_1'] = frames[0]
                        if len(frames) >= 2:
                            rec['rotinas']['q1_2'] = frames[1]
                        if len(frames) >= 2:
                            rec['q1'] = round(frames[0]['total'] + frames[1]['total'], 3)
                        elif perf_mk is not None:
                            rec['q1'] = perf_mk
                        elif len(frames) == 1:
                            rec['q1'] = frames[0]['total']
                    elif kind == 'F1':
                        rt = frames[0] if frames else {'total': perf_mk}
                        rec['f1'] = rt['total']
                        rec['rotinas']['f1'] = rt
                    elif kind == 'F2':
                        rt = frames[0] if frames else {'total': perf_mk}
                        rec['f2'] = rt['total']
                        rec['rotinas']['f2'] = rt
                    elif kind == 'F':
                        if len(frames) >= 1:
                            rec['f1'] = frames[0]['total']
                            rec['rotinas']['f1'] = frames[0]
                        if len(frames) >= 2:
                            rec['f2'] = frames[1]['total']
                            rec['rotinas']['f2'] = frames[1]

                    ne_min = ((minimos.get(disc) or {}).get(sex) or {}).get('ne')
                    if ne_min is not None:
                        best_single = max([rt['total'] for rt in rec['rotinas'].values()] or [0])
                        if best_single >= ne_min:
                            rec['ne'] = best_single

    return event_records, any_live


def detect_disc_sex_phase(title):
    t = title.lower()
    if 'synchro' in t or 'team' in t or 'all around' in t or 'mixed' in t:
        return None, None, None
    if 'trampoline' in t:
        disc = 'TRI'
    elif 'double mini' in t or 'dmt' in t:
        disc = 'DMT'
    elif 'tumbling' in t:
        disc = 'TUM'
    else:
        return None, None, None

    if 'women' in t:
        sex = 'F'
    elif 'men' in t:
        sex = 'M'
    else:
        return None, None, None

    if 'qualification round 2' in t or 'qual. round 2' in t:
        phase = 'Q2'
    elif 'qualification' in t:
        phase = 'Q'
    elif 'final 1' in t:
        phase = 'F1'
    elif 'final 2' in t:
        phase = 'F2'
    elif 'final' in t:
        phase = 'F'
    else:
        phase = None
    return disc, sex, phase


def fetch_longines(event_code, athletes, minimos):
    ref = f'{BASE_LONGINES}/2026/Trampoline-{event_code}/en-us/Default'
    sched = None
    for url in (
        f'{BASE_LONGINES}/2026/Trampoline-{event_code}/api/Schedule',
        f'{BASE_LONGINES}/File/GetSchedule?eventId={event_code}&lang=en-us',
    ):
        try:
            sched = get_json(url, referer=ref, retries=1)
            if sched:
                break
        except Exception:
            continue

    if not sched:
        raise RuntimeError(f'Longines ({event_code}): agenda indisponível via API direta.')

    records = {}
    any_live = False
    raw_dump = json.dumps(sched)
    unit_ids = sorted(set(re.findall(r'"(?:UnitId|PhaseId|Id)"\s*:\s*"([A-Z0-9_-]{8,})"', raw_dump)))

    for uid in unit_ids:
        data = None
        for r_url in (
            f'{BASE_LONGINES}/2026/Trampoline-{event_code}/api/Results/{uid}',
            f'{BASE_LONGINES}/File/GetResults?eventId={event_code}&phaseId={uid}&lang=en-us',
        ):
            try:
                data = get_json(r_url, referer=ref, retries=1)
                if data:
                    break
            except Exception:
                continue
        if not data:
            continue

        title = str(data.get('Title') or data.get('PhaseName') or data.get('Name') or '')
        disc, sex, phase = detect_disc_sex_phase(title)
        if not disc or not phase:
            continue
        if str(data.get('Status') or '').lower() in ('running', 'live', 'inprogress'):
            any_live = True

        rows = data.get('Results') or data.get('Rows') or data.get('Athletes') or []
        for row in rows:
            noc = str(row.get('NOC') or row.get('Country') or row.get('Representing') or '').upper()
            if noc != 'POR':
                continue
            name = str(row.get('FullName') or row.get('Name') or f"{row.get('GivenName', '')} {row.get('FamilyName', '')}")
            ath = match_athlete(athletes, name, disc, sex)
            if not ath:
                continue

            ex_list = []
            for ex in row.get('Exercises') or row.get('Routines') or [row]:
                tot = ex.get('Total') or ex.get('Score') or ex.get('Mark')
                if tot is None:
                    continue
                try:
                    tot_f = round(float(str(tot).replace(',', '.')), 3)
                except ValueError:
                    continue
                if tot_f <= 0:
                    continue
                rt = {'total': tot_f, 'p': 0.0}
                for k_src, k_dst in (('E', 'e'), ('Execution', 'e'), ('D', 'd'), ('Difficulty', 'd'), ('H', 'hd'), ('HD', 'hd'), ('T', 'tof'), ('ToF', 'tof'), ('P', 'p'), ('Penalty', 'p')):
                    if ex.get(k_src) is not None:
                        try:
                            rt[k_dst] = round(float(str(ex[k_src]).replace(',', '.')), 3)
                        except ValueError:
                            pass
                ex_list.append(rt)

            if not ex_list:
                continue

            rec = records.setdefault(ath['id'], {'rotinas': {}})
            if disc == 'TRI':
                if phase == 'Q':
                    if len(ex_list) >= 1:
                        rec['rotinas']['q1_1'] = ex_list[0]
                    if len(ex_list) >= 2:
                        rec['rotinas']['q1_2'] = ex_list[1]
                    best_f = max(ex_list, key=lambda x: x['total'])
                    rec['q1'] = best_f['total']
                    rec['rotinas']['q1'] = best_f
                elif phase == 'Q2':
                    rec['q2'] = ex_list[0]['total']
                    rec['rotinas']['q2'] = ex_list[0]
                elif phase in ('F', 'F1'):
                    rec['f'] = ex_list[0]['total']
                    rec['rotinas']['f'] = ex_list[0]
            else:
                if phase == 'Q':
                    if len(ex_list) >= 1:
                        rec['rotinas']['q1_1'] = ex_list[0]
                    if len(ex_list) >= 2:
                        rec['rotinas']['q1_2'] = ex_list[1]
                    if len(ex_list) >= 2:
                        rec['q1'] = round(ex_list[0]['total'] + ex_list[1]['total'], 3)
                    elif len(ex_list) == 1:
                        rec['q1'] = ex_list[0]['total']
                elif phase == 'F1':
                    rec['f1'] = ex_list[0]['total']
                    rec['rotinas']['f1'] = ex_list[0]
                elif phase == 'F2':
                    rec['f2'] = ex_list[0]['total']
                    rec['rotinas']['f2'] = ex_list[0]
                elif phase == 'F':
                    if len(ex_list) >= 1:
                        rec['f1'] = ex_list[0]['total']
                        rec['rotinas']['f1'] = ex_list[0]
                    if len(ex_list) >= 2:
                        rec['f2'] = ex_list[1]['total']
                        rec['rotinas']['f2'] = ex_list[1]

                ne_min = ((minimos.get(disc) or {}).get(sex) or {}).get('ne')
                if ne_min is not None:
                    best_single = max([rt['total'] for rt in rec['rotinas'].values()] or [0])
                    if best_single >= ne_min:
                        rec['ne'] = best_single

    return records, any_live


def is_event_active_now(ev):
    if not ev.get('codigo') or not ev.get('inicio') or not ev.get('fim'):
        return False
    tz_name = ev.get('fuso') or 'Europe/Lisbon'
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo('UTC')

    now_local = dt.datetime.now(tz)
    d_start = dt.date.fromisoformat(ev['inicio'])
    d_end = dt.date.fromisoformat(ev['fim'])

    if not (d_start <= now_local.date() <= d_end):
        return False

    # Janela diária de competição no fuso local do evento: 08:00 às 22:00
    t_now = now_local.time()
    return dt.time(8, 0) <= t_now <= dt.time(22, 0)


def git_commit_push(out_path, msg):
    subprocess.run(['git', 'add', out_path], capture_output=True)
    if subprocess.run(['git', 'diff', '--cached', '--quiet'], capture_output=True).returncode == 0:
        return True
    subprocess.run(['git', 'commit', '-m', msg], capture_output=True)
    for _ in range(4):
        if subprocess.run(['git', 'push'], capture_output=True).returncode == 0:
            return True
        subprocess.run(['git', 'pull', '--rebase', '-X', 'theirs'], capture_output=True)
        time.sleep(2)
    return False


def sync_single_event(ev, athletes, minimos, out_path, live_mode=False, git_push=False):
    fonte = (ev.get('fonte') or 'sporttech').lower()
    codigo = ev.get('codigo')
    if not codigo:
        print(f"Evento {ev['id']} sem 'codigo' configurado em config.json.")
        return False

    if fonte == 'longines':
        records, any_live = fetch_longines(codigo, athletes, minimos)
    else:
        records, any_live = fetch_sporttech(codigo, athletes, minimos, national_mode=bool(ev.get('nacional')))

    if os.path.exists(out_path):
        doc = json.load(open(out_path, encoding='utf-8'))
    else:
        doc = {'live': False, 'updatedAt': None, 'resultados': {}}

    doc.setdefault('resultados', {})[ev['id']] = records
    doc['live'] = bool(any_live and live_mode)
    doc['updatedAt'] = dt.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'

    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    print(f"[{doc['updatedAt']}] {ev['id']} ({fonte}): {len(records)} atletas gravados (live={doc['live']}).")
    if git_push:
        git_commit_push(out_path, f"Resultados: {ev['curto']} ({fonte})")
    return any_live


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--event-id', default='', help='Forçar sincronização única de um evento específico (ex: cottbus, nanjing)')
    ap.add_argument('--out', default='data/results.json', help='Ficheiro JSON de destino')
    ap.add_argument('--poll', type=int, default=30, help='Intervalo de polling em modo automático (segundos)')
    ap.add_argument('--budget', type=int, default=19800, help='Duração máxima de um ciclo de polling (segundos)')
    ap.add_argument('--git-push', action='store_true', help='Fazer commit & push quando houver alterações')
    args = ap.parse_args()

    cfg = json.load(open('data/config.json', encoding='utf-8'))
    athletes = json.load(open('data/athletes.json', encoding='utf-8'))
    minimos = cfg.get('minimos') or {}
    eventos = cfg.get('eventos') or []

    if args.git_push:
        subprocess.run(['git', 'config', 'user.name', 'Resultados Trampolins'], capture_output=True)
        subprocess.run(['git', 'config', 'user.email', 'actions@users.noreply.github.com'], capture_output=True)

    # Modo manual (Run workflow com event_id): leitura única e rápida (~5-10s)
    if args.event_id:
        ev = next((e for e in eventos if e['id'] == args.event_id), None)
        if not ev:
            print(f"Erro: evento '{args.event_id}' não encontrado em config.json.", file=sys.stderr)
            sys.exit(1)
        sync_single_event(ev, athletes, minimos, args.out, live_mode=False, git_push=args.git_push)
        return

    # Modo automático (cron): verifica se há algum evento a decorrer no seu fuso horário local
    active = [e for e in eventos if is_event_active_now(e)]
    if not active:
        print('Nenhuma competição a decorrer neste momento (08:00–22:00 locais segundo config.json). A sair.')
        return

    t0 = time.time()
    while True:
        still_active = [e for e in eventos if is_event_active_now(e)]
        if not still_active:
            if os.path.exists(args.out):
                doc = json.load(open(args.out, encoding='utf-8'))
                if doc.get('live'):
                    doc['live'] = False
                    doc['updatedAt'] = dt.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'
                    with open(args.out, 'w', encoding='utf-8') as f:
                        json.dump(doc, f, ensure_ascii=False, indent=2)
                    if args.git_push:
                        git_commit_push(args.out, 'Resultados: fim da competição (live=false)')
            print('Competição fora da janela horária (08:00–22:00 locais). A encerrar.')
            break

        for ev in still_active:
            try:
                sync_single_event(ev, athletes, minimos, args.out, live_mode=True, git_push=args.git_push)
            except Exception as err:
                print(f"Erro ao sincronizar {ev['id']}: {err}", file=sys.stderr)

        if (time.time() - t0) >= args.budget:
            break
        time.sleep(args.poll)


if __name__ == '__main__':
    main()
