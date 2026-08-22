#!/usr/bin/env python3
"""Compute a directional market-support index from the expanded signal ledger.

This is a prioritization aid, not a demand forecast. Low-confidence community
signals remain included through explicit source, recency, and engagement
weights instead of being discarded.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LEDGER = ROOT / "expanded-signal-ledger.csv"
OUTPUT = ROOT / "expanded-signal-scorecard.json"


def main() -> None:
    demand = defaultdict(float)
    competition = defaultdict(float)
    channels: dict[str, set[str]] = defaultdict(set)
    rows_by_opportunity = defaultdict(int)

    with LEDGER.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))

    for row in rows:
        contribution = (
            float(row["source_weight"])
            * float(row["recency_weight"])
            * float(row["engagement_weight"])
        )
        direction = row["direction"]
        for opportunity in row["opportunities"].split("|"):
            rows_by_opportunity[opportunity] += 1
            channels[opportunity].add(row["channel"])
            if direction == "competition":
                competition[opportunity] += contribution
            elif direction == "positive_use":
                demand[opportunity] += contribution * 0.5
            else:
                demand[opportunity] += contribution

    records = []
    for opportunity in sorted(rows_by_opportunity):
        channel_multiplier = 1 + min(0.48, 0.08 * (len(channels[opportunity]) - 1))
        converged = demand[opportunity] * channel_multiplier
        adjusted = converged / (1 + 0.20 * competition[opportunity])
        records.append(
            {
                "opportunity": opportunity,
                "signalRows": rows_by_opportunity[opportunity],
                "independentChannels": len(channels[opportunity]),
                "demandSupport": round(demand[opportunity], 4),
                "competitionPressure": round(competition[opportunity], 4),
                "channelMultiplier": round(channel_multiplier, 2),
                "adjustedSupport": round(adjusted, 4),
            }
        )

    highest = max(item["adjustedSupport"] for item in records)
    for item in records:
        item["relativeIndex"] = round(100 * item["adjustedSupport"] / highest, 1)

    records.sort(key=lambda item: item["relativeIndex"], reverse=True)
    payload = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-22",
        "status": "directional-signal-index-not-demand-forecast",
        "method": {
            "rowContribution": "source_weight * recency_weight * engagement_weight",
            "positiveUseContribution": "0.5 * rowContribution",
            "channelMultiplier": "1 + min(0.48, 0.08 * (independentChannels - 1))",
            "adjustedSupport": "demandSupport * channelMultiplier / (1 + 0.20 * competitionPressure)",
            "relativeIndex": "100 * adjustedSupport / maximumAdjustedSupport",
        },
        "signalRows": len(rows),
        "opportunities": records,
    }
    OUTPUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
