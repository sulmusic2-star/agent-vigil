#!/usr/bin/env python3
"""Simulate every idea in ideas.py and write the comparison.

    python3 idea-sim/run.py                 # all ideas, 20,000 runs each
    python3 idea-sim/run.py --runs 5000     # faster
    python3 idea-sim/run.py --sensitivity local-ai-rank

Writes results/summary.json (every idea's numbers) and prints a ranked table.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402

from ideas import IDEAS  # noqa: E402
from model import input_ranges, sensitivity, simulate  # noqa: E402


def money(x: float) -> str:
    sign = "-" if x < 0 else ""
    x = abs(x)
    if x >= 1_000_000:
        return f"{sign}${x / 1_000_000:.1f}M"
    if x >= 10_000:
        return f"{sign}${x / 1_000:.0f}k"
    if x >= 1_000:
        return f"{sign}${x / 1_000:.1f}k"
    return f"{sign}${x:.0f}"


def pct(x: float) -> str:
    return f"{100 * x:.0f}%"


def monthly_curve(result, points=(3, 6, 9, 12, 18, 24)) -> list[dict]:
    rows = []
    for m in points:
        if m > result.months:
            continue
        p = result.profit[m - 1]
        rows.append({"month": m, "p10": float(np.percentile(p, 10)), "p50": float(np.percentile(p, 50)),
                     "p90": float(np.percentile(p, 90)), "mean": float(p.mean()),
                     "revenueP50": float(np.percentile(result.revenue[m - 1], 50)),
                     "customersP50": float(np.percentile(result.customers[m - 1], 50))})
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--runs", type=int, default=20_000)
    parser.add_argument("--sensitivity", action="append", default=[], metavar="KEY",
                        help="also run a sensitivity analysis for this idea (repeatable)")
    parser.add_argument("--out", default=str(HERE / "results"))
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summaries = []
    for idea in IDEAS:
        result = simulate(idea, runs=args.runs)
        summary = result.summary()
        summary["curve"] = monthly_curve(result)
        summary["inputs"] = {name: {"p10": r.p10, "p50": r.p50, "p90": r.p90, "source": r.source}
                             for name, r in input_ranges(idea).items()}
        summary["pitch"], summary["worksIn"], summary["scalesTo"] = idea.pitch, idea.works_in, idea.scales_to
        summary["howFound"], summary["setupByYou"], summary["risks"] = idea.how_found, idea.setup_by_you, idea.risks
        # Money per hour of the owner's time, on the median month-24 profit.
        summary["perYourHour24"] = summary["month24"]["p50"] / max(np.mean(idea.your_hours_per_month), 0.5)
        if idea.key in args.sensitivity:
            summary["sensitivity"] = sensitivity(idea)
        summaries.append(summary)

    # "Most money": the typical (median) total profit over two years, then the average.
    ranked = sorted(summaries, key=lambda s: (s["total24"]["p50"], s["meanTotal24"]), reverse=True)
    (out / "summary.json").write_text(json.dumps({"runs": args.runs, "ideas": ranked}, indent=2))

    head = (f"{'Idea':<34} {'2-yr total: typical':>19} {'average':>8} {'1-in-10 good':>12} {'lose money':>10} "
            f"{'>=$50k':>7} {'month 24 typical':>16} {'>=$1k/mo by m12':>15} {'cash at risk':>12} {'your h/mo':>9}")
    print(head)
    print("-" * len(head))
    for s in ranked:
        print(f"{s['name'][:34]:<34} {money(s['total24']['p50']):>19} {money(s['meanTotal24']):>8} "
              f"{money(s['total24']['p90']):>12} {pct(s['chanceLoseMoney']):>10} {pct(s['chanceTotal50k']):>7} "
              f"{money(s['month24']['p50']):>16} {pct(s['chance1kBy12']):>15} {money(-s['worstCashLow']):>12} "
              f"{s['yourHours'][0]:g}-{s['yourHours'][1]:g}".rjust(9))
    for s in ranked:
        if "sensitivity" in s:
            print(f"\nWhat moves {s['name']} most (mean month-24 profit with the input at its P10 vs P90):")
            for row in s["sensitivity"][:10]:
                print(f"  {row['input']:<40} {money(row['atP10']):>8} -> {money(row['atP90']):>8}   ({row['range']})")
    print(f"\nWrote {out / 'summary.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
