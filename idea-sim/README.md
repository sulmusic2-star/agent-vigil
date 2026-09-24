# idea-sim

A Monte Carlo model that compares business ideas whose customers find them without outreach: through a marketplace, search, or ads that are kept only when they pay back.

```bash
pip install numpy
python3 idea-sim/run.py                          # every idea, 20,000 simulated two-year futures each
python3 idea-sim/run.py --sensitivity apify-factory
```

- `model.py`: the simulation. Each channel ramps up after launch and may never take off; customers churn; costs include fees, AI measurement shared across customers, fixed costs and ads. An idea that clearly isn't working eight months after launch is shut down.
- `ideas.py`: the ideas, with every input as a P10 / P50 / P90 range that names its source.
- `SOURCES.md`: where the numbers come from, and which are estimates.
- `results/summary.json`: written by `run.py` (not committed).

## Result (2026-09-24)

The winner is an Apify tool factory: keep adding pay-per-use tools to Apify Store, built on stable public standards and data so they rarely break. The flagship tool measures which products AI assistants recommend.

Over two years, the typical run earns $14k in total and the average run $49k. The best 1 in 10 earns $117k. It loses money in 4% of runs. Typical profit at month 24 is about $900 a month.

The runner-up is a Shopify app built on the same AI engine. It earns about the same on average ($50k) but loses money in 26% of runs.

These results compare ideas under the same assumptions. They are not a forecast. The inputs that move the winner most are how many Store users find the tools and how much each one spends. Both are estimates scaled from published Apify numbers.
