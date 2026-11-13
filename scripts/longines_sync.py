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

BASE_LONGINES = "https://gym.longinestiming.com"


def norm_tokens(s):
    x = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return [t for t in re.split(r"[^a-z]+", x) if t]


def match_athlete(athletes, raw_name, disc, sex):
    toks = norm_tokens(raw_name)
    if len(toks) < 2:
        return None
    for a in athletes:
        if a.get("disc") != disc or a.get("sexo") != sex:
            continue
        cand = norm_tokens(a.get("nome"))
        if not cand:
            continue
        if set(cand).issubset(set(toks)) or (cand[0] in toks and cand[-1] in toks):
            return a
    return None


def http_get(url, retries=3):
    for i in range(retries):
        try:
            rq = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Encoding": "gzip",
                    "Referer": f"{BASE_LONGINES}/2026/Trampoline-18189/en-us/Default",
                },
            )
            with urllib.request.urlopen(rq, timeout=25) as r:
                b = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    b = gzip.decompress(b)
                return b.decode("utf-8", errors="replace")
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 + 2 * i)


def detect_disc_sex_phase(title):
    t = title.lower()
    if "synchro" in t or "team" in t or "all around" in t or "mixed" in t:
        return None, None, None

    if "trampoline" in t:
        disc = "TRI"
    elif "double mini" in t or "dmt" in t:
        disc = "DMT"
    elif "tumbling" in t:
        disc = "TUM"
    else:
        return None, None, None

    if "women" in t:
        sex = "F"
    elif "men" in t:
        sex = "M"
    else:
        return None, None, None

    if "qualification round 2" in t or "qual. round 2" in t:
        phase = "Q2"
    elif "qualification" in t:
        phase = "Q"
    elif "final 1" in t:
        phase = "F1"
    elif "final 2" in t:
        phase = "F2"
    elif "final" in t:
        phase = "F"
    else:
        phase = None

    return disc, sex, phase


def apply_routine_scores(rec, disc, sex, phase, exercises, minimos):
    # exercises: lista de dicts [{e, d, hd, tof, p, total}, ...]
    if not exercises:
        return

    if disc == "TRI":
        if phase == "Q":
            if len(exercises) >= 1:
                rec["rotinas"]["q1_1"] = exercises[0]
            if len(exercises) >= 2:
                rec["rotinas"]["q1_2"] = exercises[1]
            best_f = max(exercises, key=lambda x: x["total"])
            rec["q1"] = best_f["total"]
            rec["rotinas"]["q1"] = best_f
        elif phase == "Q2":
            rec["q2"] = exercises[0]["total"]
            rec["rotinas"]["q2"] = exercises[0]
        elif phase in ("F", "F1"):
            rec["f"] = exercises[0]["total"]
            rec["rotinas"]["f"] = exercises[0]
    else:
        if phase == "Q":
            if len(exercises) >= 1:
                rec["rotinas"]["q1_1"] = exercises[0]
            if len(exercises) >= 2:
                rec["rotinas"]["q1_2"] = exercises[1]
            if len(exercises) >= 2:
                rec["q1"] = round(exercises[0]["total"] + exercises[1]["total"], 3)
            elif len(exercises) == 1:
                rec["q1"] = exercises[0]["total"]
        elif phase == "F1":
            rec["f1"] = exercises[0]["total"]
            rec["rotinas"]["f1"] = exercises[0]
        elif phase == "F2":
            rec["f2"] = exercises[0]["total"]
            rec["rotinas"]["f2"] = exercises[0]
        elif phase == "F":
            if len(exercises) >= 1:
                rec["f1"] = exercises[0]["total"]
                rec["rotinas"]["f1"] = exercises[0]
            if len(exercises) >= 2:
                rec["f2"] = exercises[1]["total"]
                rec["rotinas"]["f2"] = exercises[1]

        ne_min = ((minimos.get(disc) or {}).get(sex) or {}).get("ne")
        if ne_min is not None:
            best_single = max([rt["total"] for rt in rec["rotinas"].values()] or [0])
            if best_single >= ne_min:
                rec["ne"] = best_single


def parse_longines_api(event_code, athletes, minimos):
    # Tenta os endpoints JSON padrão da Swiss Timing (gym.longinestiming.com)
    records = {}
    sched_urls = [
        f"{BASE_LONGINES}/File/GetSchedule?eventId={event_code}&lang=en-us",
        f"{BASE_LONGINES}/api/events/{event_code}/schedule",
        f"{BASE_LONGINES}/2026/Trampoline-{event_code}/en-us/Default",
    ]
    raw_sched = None
    for u in sched_urls:
        try:
            txt = http_get(u)
            if txt and ("Trampoline" in txt or "Tumbling" in txt):
                raw_sched = txt
                break
        except Exception:
            continue

    if not raw_sched:
        raise RuntimeError("Não foi possível obter a agenda de provas da Longines Timing.")

    # Procura IDs de provas/fases no JSON da agenda
    phase_ids = re.findall(r'"(?:PhaseId|UnitId|Id)"\s*:\s*"?([A-Za-z0-9_-]{6,})"?', raw_sched)
    seen = set()
    for pid in phase_ids:
        if pid in seen:
            continue
        seen.add(pid)
        for res_url in (
            f"{BASE_LONGINES}/File/GetResults?eventId={event_code}&phaseId={pid}&lang=en-us",
            f"{BASE_LONGINES}/api/events/{event_code}/phases/{pid}/results",
        ):
            try:
                body = http_get(res_url)
                data = json.loads(body)
            except Exception:
                continue

            title = str(data.get("Title") or data.get("PhaseName") or data.get("Name") or "")
            disc, sex, phase = detect_disc_sex_phase(title)
            if not disc or not phase:
                continue

            rows = data.get("Results") or data.get("Rows") or data.get("Athletes") or []
            for row in rows:
                noc = str(row.get("NOC") or row.get("Country") or row.get("Representing") or "").upper()
                if noc != "POR":
                    continue
                name = str(row.get("FullName") or row.get("Name") or f"{row.get('GivenName','')} {row.get('FamilyName','')}")
                ath = match_athlete(athletes, name, disc, sex)
                if not ath:
                    continue

                ex_list = []
                for ex in row.get("Exercises") or row.get("Routines") or [row]:
                    tot = ex.get("Total") or ex.get("Score") or ex.get("Mark")
                    if tot is None:
                        continue
                    try:
                        tot_f = round(float(str(tot).replace(",", ".")), 3)
                    except ValueError:
                        continue
                    if tot_f <= 0:
                        continue
                    rt = {"total": tot_f}
                    for k_src, k_dst in (("E", "e"), ("Execution", "e"), ("D", "d"), ("Difficulty", "d"), ("H", "hd"), ("HD", "hd"), ("T", "tof"), ("ToF", "tof"), ("P", "p"), ("Penalty", "p")):
                        if ex.get(k_src) is not None:
                            try:
                                rt[k_dst] = round(float(str(ex[k_src]).replace(",", ".")), 3)
                            except ValueError:
                                pass
                    rt.setdefault("p", 0.0)
                    ex_list.append(rt)

                rec = records.setdefault(ath["id"], {"rotinas": {}})
                apply_routine_scores(rec, disc, sex, phase, ex_list, minimos)

    return records


def parse_longines_pdfs(pdf_paths, athletes, minimos):
    try:
        from pypdf import PdfReader
    except ImportError:
        import subprocess as sp
        sp.check_call([sys.executable, "-m", "pip", "install", "-q", "pypdf"])
        from pypdf import PdfReader

    records = {}
    for path in pdf_paths:
        reader = PdfReader(path)
        full_text = "\n".join(page.extract_text() or "" for page in reader.pages)
        disc, sex, phase = detect_disc_sex_phase(full_text[:1200])
        if not disc or not phase:
            print(f"Aviso: não foi possível identificar disciplina/fase em {path}", file=sys.stderr)
            continue

        lines = [ln.strip() for ln in full_text.splitlines() if ln.strip()]
        for idx, ln in enumerate(lines):
            if " POR " not in f" {ln} " and not ln.endswith(" POR") and not ln.startswith("POR "):
                continue
            block = " ".join(lines[max(0, idx - 1): min(len(lines), idx + 4)])
            ath = match_athlete(athletes, block, disc, sex)
            if not ath:
                continue

            # Extrai sequências numéricas típicas das linhas Exercise 1 / Exercise 2 da Swiss Timing
            nums = [float(x) for x in re.findall(r"\b\d{1,2}\.\d{3}\b", block)]
            ex_list = []
            if disc == "TRI" and len(nums) >= 5:
                # D, E, T, H, Total (por exercício)
                for chunk_start in range(0, len(nums) - 4, 5):
                    d_v, e_v, tof_v, hd_v, tot_v = nums[chunk_start:chunk_start + 5]
                    if abs((d_v + e_v + tof_v + hd_v) - tot_v) < 1.5:
                        ex_list.append({"d": d_v, "e": e_v, "tof": tof_v, "hd": hd_v, "p": 0.0, "total": tot_v})
            elif disc in ("DMT", "TUM") and len(nums) >= 3:
                for chunk_start in range(0, len(nums) - 2, 3):
                    d_v, e_v, tot_v = nums[chunk_start:chunk_start + 3]
                    if abs((d_v + e_v) - tot_v) < 1.5:
                        ex_list.append({"d": d_v, "e": e_v, "p": 0.0, "total": tot_v})

            if not ex_list and nums:
                # Fallback: maiores valores plausíveis de total de rotina
                totals = [v for v in nums if v >= 20.0]
                for tv in totals[:2]:
                    ex_list.append({"total": tv, "p": 0.0})

            if ex_list:
                rec = records.setdefault(ath["id"], {"rotinas": {}})
                apply_routine_scores(rec, disc, sex, phase, ex_list, minimos)

    return records


def git_commit_push(out_path):
    subprocess.run(["git", "add", out_path], capture_output=True)
    if subprocess.run(["git", "diff", "--cached", "--quiet"], capture_output=True).returncode == 0:
        return True
    subprocess.run(["git", "commit", "-m", "Resultados: Nanjing (Longines Timing)"], capture_output=True)
    for _ in range(4):
        if subprocess.run(["git", "push"], capture_output=True).returncode == 0:
            return True
        subprocess.run(["git", "pull", "--rebase", "-X", "theirs"], capture_output=True)
        time.sleep(3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--event-code", default="18189", help="Código do evento na Longines Timing (ex: 18189)")
    ap.add_argument("--event-id", default="nanjing", help="ID do evento em config.json")
    ap.add_argument("--out", default="data/results.json", help="Ficheiro JSON de destino")
    ap.add_argument("--pdf", nargs="*", help="Caminho(s) para PDF(s) oficiais de resultados da Longines")
    ap.add_argument("--git-push", action="store_true", help="Fazer commit & push automático")
    args = ap.parse_args()

    cfg = json.load(open("data/config.json", encoding="utf-8"))
    athletes = json.load(open("data/athletes.json", encoding="utf-8"))

    if args.git_push:
        subprocess.run(["git", "config", "user.name", "Resultados Trampolins"], capture_output=True)
        subprocess.run(["git", "config", "user.email", "actions@users.noreply.github.com"], capture_output=True)

    if args.pdf:
        records = parse_longines_pdfs(args.pdf, athletes, cfg.get("minimos") or {})
    else:
        records = parse_longines_api(args.event_code, athletes, cfg.get("minimos") or {})

    if os.path.exists(args.out):
        doc = json.load(open(args.out, encoding="utf-8"))
    else:
        doc = {"live": False, "updatedAt": None, "resultados": {}}

    doc.setdefault("resultados", {})[args.event_id] = records
    doc["updatedAt"] = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    print(f"[{doc['updatedAt']}] Gravados {len(records)} atletas para {args.event_id}")
    if args.git_push:
        git_commit_push(args.out)


if __name__ == "__main__":
    main()
