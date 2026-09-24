"""Monte Carlo revenue model for business ideas that get customers without outreach.

An idea is a set of ranges (see ideas.py). Each simulated run draws one value per
input and then steps month by month:

    visitors   each inbound channel (search, a marketplace, an app store) ramps up
               after launch. A channel can fail to take off at all, which is
               common, so each run first draws whether it gets traction.
    customers  new customers = visitors x conversion, plus customers bought with
               ads when ads pay for themselves. Customers carry over with churn.
    revenue    customers x revenue per customer per month.
    costs      platform and payment fees, running cost per customer, shared
               measurement cost, fixed monthly costs and ad spend. A shared
               measurement (one AI scan of a market) is paid once however many
               customers read it.
    profit     revenue - costs. Cash is the running total, starting at minus the
               upfront cost.

Ads are only kept when they pay for themselves. Every run spends a test budget in
its first month after launch and keeps a monthly budget only if the customer
acquisition cost it measured is at most the customer's lifetime gross profit
divided by a safety factor.

A run that clearly isn't working is shut down, as a sensible owner would: if eight
months after launch it has fewer than 10 customers and loses money, it stops, and
its costs and revenue drop to zero from then on.

Ranges are given as P10 / P50 / P90: a 10% chance the true value is lower than
P10, a 50% chance it is lower than P50, a 10% chance it is higher than P90.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

Z90 = 1.2815515655446004  # standard normal quantile for 90%


@dataclass(frozen=True)
class Range:
    """P10 / P50 / P90 of an uncertain input, with where the numbers come from."""

    p10: float
    p50: float
    p90: float
    source: str = "estimate"
    kind: str = "auto"  # auto (lognormal if P10 > 0, else normal clipped at 0) | lognormal | normal | share

    def sample(self, rng: np.random.Generator, n: int) -> np.ndarray:
        z = rng.standard_normal(n)  # always drawn, so pinning one input leaves the others unchanged
        if self.p10 == self.p90:
            return np.full(n, float(self.p50))
        kind = self.kind if self.kind != "auto" else ("lognormal" if self.p10 > 0 else "normal")
        if kind == "lognormal":
            lo, mid, hi = math.log(self.p10), math.log(self.p50), math.log(self.p90)
            # Different spreads below and above the median keep skewed ranges honest.
            return np.exp(mid + np.where(z < 0, (mid - lo), (hi - mid)) / Z90 * z)
        if kind == "share":
            lo, mid, hi = (_logit(self.p10), _logit(self.p50), _logit(self.p90))
            return _expit(mid + np.where(z < 0, (mid - lo), (hi - mid)) / Z90 * z)
        value = self.p50 + np.where(z < 0, (self.p50 - self.p10), (self.p90 - self.p50)) / Z90 * z
        return np.maximum(value, 0.0) if self.p10 >= 0 else value

    def describe(self, unit: str = "") -> str:
        return f"{_fmt(self.p10)}{unit} / {_fmt(self.p50)}{unit} / {_fmt(self.p90)}{unit}"


def fixed(value: float, source: str = "fixed") -> Range:
    return Range(value, value, value, source)


def share(p10: float, p50: float, p90: float, source: str = "estimate") -> Range:
    """A probability or rate between 0 and 1."""

    return Range(p10, p50, p90, source, kind="share")


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _expit(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def _fmt(x: float) -> str:
    if x == 0:
        return "0"
    if abs(x) >= 100:
        return f"{x:,.0f}"
    if abs(x) >= 1:
        return f"{x:,.2f}".rstrip("0").rstrip(".")
    return f"{x:.4g}"


@dataclass(frozen=True)
class Channel:
    """A way customers find the product on their own."""

    name: str
    visitors_at_maturity: Range   # visitors (or marketplace users) per month once mature, if it works
    months_to_mature: Range       # ramp time constant: ~63% of maturity after this many months
    conversion: Range             # share of a month's visitors who become paying customers
    traction: Range               # chance the channel works at all
    no_traction_share: float = 0.05  # traffic a channel that "doesn't work" still gets, as a share
    starts_after: float = 0.0     # months after launch before the channel starts
    per_public_market: bool = False  # visitors_at_maturity is per published market page


@dataclass(frozen=True)
class Ads:
    """Paid acquisition that is kept only when it pays for itself."""

    cost_per_click: Range
    click_to_customer: Range      # share of ad clicks that become paying customers
    monthly_budget: float         # budget once ads have proven to pay back
    test_budget: float            # one test month right after launch
    payback_factor: float = 1.5   # keep ads only if lifetime gross profit >= this x CAC
    max_lifetime_months: float = 24.0


@dataclass(frozen=True)
class Measurement:
    """Shared measurement: scan a market once, and every customer in it reads the result."""

    public_markets: Range                  # markets published as free pages once search traffic comes
    cost_per_public_market_month: Range    # keeping one public market page fresh
    effective_markets: Range               # how many distinct markets paying customers spread across
    cost_per_customer_market_month: Range  # deeper tracking for a market that has paying customers
    start_markets: float = 200             # pages kept while search traffic hasn't taken off


@dataclass
class Idea:
    key: str
    name: str
    pitch: str                      # one line: what it is
    works_in: str                   # the niche where this already works, with evidence
    scales_to: str                  # the much bigger market
    how_found: str                  # how customers find it without outreach
    channels: list[Channel]
    price: Range                    # revenue per customer per month
    churn: Range                    # share of customers lost per month
    platform_fee: float             # share of revenue kept by marketplace / payment provider
    fee_per_payment: float = 0.0    # fixed fee per monthly payment (for example $0.30)
    cost_per_customer: Range = field(default_factory=lambda: fixed(0.0))
    cost_per_visitor: Range = field(default_factory=lambda: fixed(0.0))  # serving free users (free checks)
    cost_share: Range = field(default_factory=lambda: fixed(0.0))        # running costs that scale with revenue
    fixed_monthly: Range = field(default_factory=lambda: fixed(0.0))
    upfront: Range = field(default_factory=lambda: fixed(0.0))
    build_months: Range = field(default_factory=lambda: fixed(1.0))
    ads: Ads | None = None
    measurement: Measurement | None = None
    max_customers: float = 1e9      # hard cap, for example a share of the whole market
    your_hours_per_month: tuple[float, float] = (1, 4)  # the owner's time once running (low, high)
    setup_by_you: str = ""
    risks: list[str] = field(default_factory=list)


@dataclass
class Result:
    idea: Idea
    months: int
    runs: int
    profit: np.ndarray       # [months, runs] monthly profit
    revenue: np.ndarray      # [months, runs]
    customers: np.ndarray    # [months, runs]
    ad_spend: np.ndarray     # [months, runs]
    cash: np.ndarray         # [months, runs] cumulative, after upfront cost
    ads_kept: np.ndarray     # [runs] whether ads paid back and were kept
    stopped: np.ndarray      # [runs] shut down because it wasn't working

    def at(self, month: int) -> np.ndarray:
        return self.profit[month - 1]

    def summary(self) -> dict:
        p12, p24 = self.at(12), self.at(min(24, self.months))
        cash_end = self.cash[-1]
        low_point = np.minimum(self.cash.min(axis=0), 0)
        positive = self.profit > 0
        # break-even: first month from which cumulative cash stays >= 0
        after = np.flip(np.minimum.accumulate(np.flip(self.cash, axis=0), axis=0), axis=0) >= 0
        first = np.where(after.any(axis=0), after.argmax(axis=0) + 1, np.nan)
        return {
            "key": self.idea.key,
            "name": self.idea.name,
            "month12": _pct(p12),
            "month24": _pct(p24),
            "mean12": float(p12.mean()),
            "mean24": float(p24.mean()),
            "chance1kBy12": float((p12 >= 1_000).mean()),
            "chance5kBy12": float((p12 >= 5_000).mean()),
            "chance10kBy24": float((p24 >= 10_000).mean()),
            "chance1kBy24": float((p24 >= 1_000).mean()),
            "cash24": _pct(cash_end),
            "meanCash24": float(cash_end.mean()),
            "worstCashLow": float(np.percentile(low_point, 10)),  # 1-in-10 bad case: most cash needed
            "medianCashLow": float(np.median(low_point)),
            "breakEvenMonthMedian": float(np.nanmedian(first)) if np.isfinite(first).any() else None,
            "chanceNeverBreakEven": float(np.isnan(first).mean()),
            "chanceAdsPayBack": float(self.ads_kept.mean()) if self.idea.ads else None,
            "chanceShutDown": float(self.stopped.mean()),
            "total24": _pct(cash_end),
            "meanTotal24": float(cash_end.mean()),
            "chanceLoseMoney": float((cash_end < 0).mean()),
            "chanceTotal10k": float((cash_end >= 10_000).mean()),
            "chanceTotal50k": float((cash_end >= 50_000).mean()),
            "firstRevenueMonthMedian": float(np.median(np.argmax(self.revenue > 1, axis=0) + 1)),
            "monthly": {q: [float(np.percentile(self.profit[m], q)) for m in range(self.months)] for q in (10, 50, 90)},
            "customers24": _pct(self.customers[-1]),
            "profitableMonthsShare": float(positive.mean()),
            "yourHours": list(self.idea.your_hours_per_month),
        }


def _pct(x: np.ndarray) -> dict:
    return {"p10": float(np.percentile(x, 10)), "p50": float(np.percentile(x, 50)),
            "p90": float(np.percentile(x, 90))}


STOP_CHECK_MONTH = 8        # months after launch
STOP_BELOW_CUSTOMERS = 10


def simulate(idea: Idea, runs: int = 20_000, months: int = 24, seed: int = 7,
             overrides: dict[str, float] | None = None, stop_rule: bool = True) -> Result:
    """Simulate one idea. ``overrides`` pins named inputs (used by the sensitivity analysis)."""

    rng = np.random.default_rng(seed)
    pins = overrides or {}

    def draw(name: str, r: Range) -> np.ndarray:
        values = r.sample(rng, runs)
        return np.full(runs, float(pins[name])) if name in pins else values

    build = draw("build_months", idea.build_months)
    price = draw("price", idea.price)
    churn = np.clip(draw("churn", idea.churn), 0.003, 1.0)
    unit_cost = draw("cost_per_customer", idea.cost_per_customer)
    fixed_cost = draw("fixed_monthly", idea.fixed_monthly)
    upfront = draw("upfront", idea.upfront)

    meas = idea.measurement
    if meas is not None:
        public_markets = draw("public_markets", meas.public_markets)
        public_cost = draw("cost_per_public_market_month", meas.cost_per_public_market_month)
        eff_markets = np.maximum(draw("effective_markets", meas.effective_markets), 1)
        market_cost = draw("cost_per_customer_market_month", meas.cost_per_customer_market_month)
    else:
        public_markets = public_cost = market_cost = np.zeros(runs)
        eff_markets = np.ones(runs)

    visitor_cost = draw("cost_per_visitor", idea.cost_per_visitor)
    revenue_cost = draw("cost_share", idea.cost_share)
    channels = []
    for ch in idea.channels:
        vmax = draw(f"{ch.name}:visitors", ch.visitors_at_maturity)
        tau = np.maximum(draw(f"{ch.name}:months_to_mature", ch.months_to_mature), 0.25)
        conv = draw(f"{ch.name}:conversion", ch.conversion)
        works = rng.random(runs) < draw(f"{ch.name}:traction", ch.traction)
        if ch.per_public_market and meas is not None:
            # Grow the free pages only where search traffic shows up; otherwise keep a small set.
            public_markets = np.where(works, public_markets, np.minimum(public_markets, meas.start_markets))
            vmax = vmax * public_markets
        vmax = vmax * np.where(works, 1.0, ch.no_traction_share)
        channels.append((vmax, tau, conv, ch.starts_after))

    gross_per_customer = price * (1 - idea.platform_fee - revenue_cost) - idea.fee_per_payment - unit_cost
    if idea.ads is not None:
        ads = idea.ads
        cac = draw("ads:cost_per_click", ads.cost_per_click) / np.maximum(
            draw("ads:click_to_customer", ads.click_to_customer), 1e-6)
        lifetime = np.minimum(1 / churn, ads.max_lifetime_months)
        ads_kept = gross_per_customer * lifetime >= ads.payback_factor * cac
    else:
        cac = np.full(runs, np.inf)
        ads_kept = np.zeros(runs, dtype=bool)

    profit = np.zeros((months, runs))
    revenue = np.zeros((months, runs))
    customers_hist = np.zeros((months, runs))
    ad_hist = np.zeros((months, runs))
    cash_hist = np.zeros((months, runs))
    customers = np.zeros(runs)
    cash = -upfront
    stopped = np.zeros(runs, dtype=bool)
    checked = np.zeros(runs, dtype=bool)
    for m in range(1, months + 1):
        age = m - build            # months since launch
        live = age > 0
        new = np.zeros(runs)
        visitors = np.zeros(runs)
        for vmax, tau, conv, start in channels:
            a = np.clip(age - start, 0, None)
            ramp = 1 - np.exp(-a / tau)
            v = vmax * ramp * rng.lognormal(0.0, 0.25, runs)
            visitors += v
            new += v * conv
        spend = np.zeros(runs)
        if idea.ads is not None:
            testing = live & (age <= 1)
            spend = np.where(testing, idea.ads.test_budget,
                             np.where(live & ads_kept, idea.ads.monthly_budget, 0.0))
            new += spend / cac
        customers = np.minimum(customers * (1 - churn) + new * live, idea.max_customers)
        rev = customers * price
        fees = rev * (idea.platform_fee + revenue_cost) + customers * idea.fee_per_payment
        shared = (public_markets * public_cost
                  + eff_markets * (1 - np.exp(-customers / eff_markets)) * market_cost) * live
        cost = fees + customers * unit_cost + visitors * visitor_cost + shared + fixed_cost * live + spend
        month_profit = np.where(stopped, 0.0, rev - cost)
        rev = np.where(stopped, 0.0, rev)
        spend = np.where(stopped, 0.0, spend)
        customers = np.where(stopped, 0.0, customers)
        if stop_rule:
            due = live & ~checked & (age >= STOP_CHECK_MONTH)
            stopped |= due & (customers < STOP_BELOW_CUSTOMERS) & (month_profit < 0)
            checked |= due
        cash = cash + month_profit
        profit[m - 1], revenue[m - 1], customers_hist[m - 1] = month_profit, rev, customers
        ad_hist[m - 1], cash_hist[m - 1] = spend, cash
    return Result(idea, months, runs, profit, revenue, customers_hist, ad_hist, cash_hist, ads_kept, stopped)


def input_ranges(idea: Idea) -> dict[str, Range]:
    """Every uncertain input of an idea by name, for the sensitivity analysis."""

    ranges = {"build_months": idea.build_months, "price": idea.price, "churn": idea.churn,
              "cost_per_customer": idea.cost_per_customer, "cost_per_visitor": idea.cost_per_visitor,
              "cost_share": idea.cost_share,
              "fixed_monthly": idea.fixed_monthly, "upfront": idea.upfront}
    if idea.measurement is not None:
        m = idea.measurement
        ranges.update({"public_markets": m.public_markets,
                       "cost_per_public_market_month": m.cost_per_public_market_month,
                       "effective_markets": m.effective_markets,
                       "cost_per_customer_market_month": m.cost_per_customer_market_month})
    for ch in idea.channels:
        ranges.update({f"{ch.name}:visitors": ch.visitors_at_maturity,
                       f"{ch.name}:months_to_mature": ch.months_to_mature,
                       f"{ch.name}:conversion": ch.conversion,
                       f"{ch.name}:traction": ch.traction})
    if idea.ads is not None:
        ranges.update({"ads:cost_per_click": idea.ads.cost_per_click,
                       "ads:click_to_customer": idea.ads.click_to_customer})
    return {k: v for k, v in ranges.items() if v.p10 != v.p90}


def sensitivity(idea: Idea, month: int = 24, runs: int = 4_000) -> list[dict]:
    """Swing each input from its P10 to its P90, others uncertain as usual; report mean profit."""

    rows = []
    for name, r in input_ranges(idea).items():
        low = simulate(idea, runs=runs, overrides={name: r.p10}).at(month).mean()
        high = simulate(idea, runs=runs, overrides={name: r.p90}).at(month).mean()
        rows.append({"input": name, "atP10": float(low), "atP90": float(high), "swing": float(abs(high - low)),
                     "range": r.describe(), "source": r.source})
    return sorted(rows, key=lambda row: row["swing"], reverse=True)
