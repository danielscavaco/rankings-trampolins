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

KIND_MAP = {0: 'Q', 6: 'Q2', 3: 'F', 8: 'F1', 7: 'F2'}
DISC_MAP = {0: 'TRI', 1: 'SYN', 2: 'DMT', 3: 'TUM'}


def get_json(url, retries=3):
    for i in range(retries):
        try:
            rq = urllib.request.Request(
                url,
                headers={
                    'User-Agent': 'Mozilla/5.0 (FGP Apuramento JE 2027 relay)',
                    'Accept': 'application/json',
                    'Accept-Encoding': 'gzip',
                },
            )
            with urllib.request.urlopen(rq, timeout=25) as r:
                b = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    b = gzip.decompress(b)
                return json.loads(b.decode('utf-8'))
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 + 3 * i)


def norm_tokens(s):
    x = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return [t for t in re.split(r'[^a-z]+', x) if t]


def match_athlete(athletes, gn, sn, disc, sex):
    gt = norm_tokens(gn)
    st = norm_tokens(sn)
    if not gt or not st:
        return None
    full_query = gt + st
    for a in athletes:
        if a.get('disc') != disc or a.get('sexo') != sex:
            continue
        cand = norm_tokens(a.get('nome'))
        if not cand:
            continue
        if cand == full_query:
            return a
        if cand[0] == gt[0] and cand[-1] in st:
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


def fetch_event_results(uuid, athletes, minimos, ignore_age=False, national_mode=False):
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
        if not ignore_age and not is_senior(c.get('AgeGroup')):
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
                ath = match_athlete(athletes, a0.get('GivenName', ''), a0.get('Surname', ''), disc, sex)
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
                        # Q1 em TRI tem 2 séries: guarda ambas e escolhe a melhor
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


def git_commit_push(out_path):
    subprocess.run(['git', 'add', out_path], capture_output=True)
    if subprocess.run(['git', 'diff', '--cached', '--quiet'], capture_output=True).returncode == 0:
        return True
    subprocess.run(['git', 'commit', '-m', 'Resultados: atualização automática (Sporttech)'], capture_output=True)
    for _ in range(4):
        if subprocess.run(['git', 'push'], capture_output=True).returncode == 0:
            return True
        subprocess.run(['git', 'pull', '--rebase', '-X', 'theirs'], capture_output=True)
        time.sleep(3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--uuid', required=True, help='UUID do evento na Sporttech')
    ap.add_argument('--event-id', required=True, help='ID do evento em config.json (ex: cottbus)')
    ap.add_argument('--out', default='data/results.json', help='Ficheiro JSON de destino')
    ap.add_argument('--poll', type=int, default=0, help='Segundos entre leituras (0 = leitura única)')
    ap.add_argument('--budget', type=int, default=20400, help='Duração máxima do loop em segundos')
    ap.add_argument('--ignore-age', action='store_true', help='Não filtrar por escalão Sénior (útil para testes)')
    ap.add_argument('--national', action='store_true', help='Prova nacional (não exigir Representing == POR)')
    ap.add_argument('--git-push', action='store_true', help='Fazer commit & push automático quando houver alterações')
    args = ap.parse_args()

    cfg = json.load(open('data/config.json', encoding='utf-8'))
    athletes = json.load(open('data/athletes.json', encoding='utf-8'))

    if args.git_push:
        subprocess.run(['git', 'config', 'user.name', 'Resultados Trampolins'], capture_output=True)
        subprocess.run(['git', 'config', 'user.email', 'actions@users.noreply.github.com'], capture_output=True)

    t0 = time.time()
    last_snapshot = None
    last_commit = 0

    while True:
        try:
            if os.path.exists(args.out):
                doc = json.load(open(args.out, encoding='utf-8'))
            else:
                doc = {'live': False, 'updatedAt': None, 'resultados': {}}

            records, is_live = fetch_event_results(
                args.uuid,
                athletes,
                cfg.get('minimos') or {},
                ignore_age=args.ignore_age,
                national_mode=args.national,
            )

            doc.setdefault('resultados', {})[args.event_id] = records
            doc['live'] = bool(is_live and args.poll > 0)

            snap = json.dumps(doc['resultados'], sort_keys=True, ensure_ascii=False)
            if snap != last_snapshot and (time.time() - last_commit >= 60 or args.poll == 0):
                doc['updatedAt'] = dt.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'
                os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
                with open(args.out, 'w', encoding='utf-8') as f:
                    json.dump(doc, f, ensure_ascii=False, indent=2)
                print(f'[{doc["updatedAt"]}] Gravados {len(records)} atletas para {args.event_id} (live={doc["live"]})')
                if args.git_push:
                    git_commit_push(args.out)
                last_snapshot = snap
                last_commit = time.time()
        except Exception as e:
            print('Erro na leitura Sporttech:', e, file=sys.stderr)

        if args.poll <= 0 or (time.time() - t0) >= args.budget:
            break
        time.sleep(args.poll)


if __name__ == '__main__':
    main()
