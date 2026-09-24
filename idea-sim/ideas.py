"""The ideas being compared, with every input as a P10 / P50 / P90 range.

Every idea gets its customers without outreach: people find it through search, a
marketplace or an app store, or through ads that are kept only if they pay back.

Each input names its source key from SOURCES.md, or says "estimate". The chance a
channel works at all ("traction") is set from base rates, and most new products
never get meaningful traffic:
  * new website, search traffic: 0.12-0.35 (only 1.74% of new pages reach Google's
    top 10 within a year, and AI Overviews take many of the clicks);
  * marketplace listing (Apify Store, Shopify App Store): 0.2-0.6, depending on how
    crowded the category is. Marketplaces show new listings to buyers who are
    already searching.
"""

from __future__ import annotations

from model import Ads, Channel, Idea, Measurement, Range, fixed, share

STRIPE = 0.029 + 0.005   # card fee plus Stripe Billing, as a share of revenue
STRIPE_FIXED = 0.30      # per payment
APIFY_FEE = 0.20         # apify-payouts: developers keep 80%

# One AI answer with live web search costs about $0.01-0.03 (api-prices).
# A light public refresh is 24 answers a month; weekly tracking of a market is about 172 answers a month.
PUBLIC_REFRESH = Range(0.24, 0.43, 0.72, "api-prices: 24 answers x $0.01-0.03")
WEEKLY_TRACKING = Range(1.7, 3.1, 5.2, "api-prices: ~172 answers x $0.01-0.03")

NEW_SITE_SEARCH = share(0.12, 0.22, 0.35, "ahrefs-new-pages; core-2026 favours pages with their own data")
SEO_RAMP = Range(7, 10, 15, "ahrefs-new-pages: rankings take many months")
SAAS_CHURN = share(0.04, 0.07, 0.115, "recurly-churn 3.8-4.3%; chartmogul-ai-churn ~11.5% for AI tools under $50")
TRIAL_TO_PAID = share(0.006, 0.013, 0.03, "fps-conversion: 8.5% of visitors start a trial, 18.2% of trials pay")
B2B_CPC = Range(5, 8, 14, "wordstream-cpc / localiq-cpc ($5.26-5.42 average; $8-9.87 for local services)")
SEARCH_TRICKLE = 0.01       # a site that never ranks still gets ~1% of the traffic it would have had
MARKETPLACE_TRICKLE = 0.10  # a marketplace still shows a new listing to some searchers


IDEAS: list[Idea] = [
    Idea(
        key="local-ai-rank",
        name="Local AI Rank (self-serve website)",
        pitch="Free weekly pages showing which businesses ChatGPT, Perplexity, Gemini and Claude "
              "recommend in each market (for example dentists in Austin); businesses subscribe to track "
              "themselves against competitors and get fixes.",
        works_in="Brand-level AI visibility tracking: Peec AI $10M ARR in 16 months, Otterly 30,000+ users "
                 "from $29/mo, Profound $1.8B.",
        scales_to="Every local business: 45% of consumers now ask AI for local recommendations, and ChatGPT "
                  "recommends only 1.2% of locations.",
        how_found="Search traffic to the free market pages and a free 'does AI recommend you' check; "
                  "badges that recommended businesses put on their sites; Google Ads when they pay back.",
        channels=[
            Channel("search: market pages", Range(1, 4, 15, "ahrefs-zero-traffic; estimate for pages with own data"),
                    SEO_RAMP, share(0.001, 0.003, 0.008, "estimate: most visitors are consumers, not owners"),
                    NEW_SITE_SEARCH, no_traction_share=SEARCH_TRICKLE, per_public_market=True),
            Channel("search: free check", Range(800, 3000, 12000, "estimate"), Range(6, 9, 14, "ahrefs-new-pages"),
                    share(0.004, 0.009, 0.02, "fps-conversion"),
                    share(0.08, 0.15, 0.25, "estimate; local-incumbents (BrightLocal, Localo, Yext) already rank"),
                    no_traction_share=SEARCH_TRICKLE),
            Channel("badges and referrals", Range(100, 400, 2000, "hubspot-grader (shared grades earned 40k links)"),
                    Range(4, 8, 12, "estimate"), share(0.005, 0.01, 0.02, "estimate"),
                    share(0.15, 0.3, 0.45, "estimate"), no_traction_share=SEARCH_TRICKLE, starts_after=2),
        ],
        price=Range(19, 29, 49, "otterly $29; local-incumbents $39"),
        churn=SAAS_CHURN,
        platform_fee=STRIPE, fee_per_payment=STRIPE_FIXED,
        cost_per_customer=Range(0.3, 0.6, 1.2, "estimate: email, storage, compute"),
        cost_per_visitor=Range(0.002, 0.006, 0.02, "estimate: free checks, mostly cached markets"),
        fixed_monthly=Range(30, 60, 150, "estimate: hosting, domain, email"),
        upfront=Range(50, 150, 400, "estimate: domain, first scans"),
        build_months=Range(1, 1.5, 2.5, "estimate"),
        ads=Ads(B2B_CPC, TRIAL_TO_PAID, monthly_budget=1000, test_budget=400),
        measurement=Measurement(public_markets=Range(500, 1500, 4000, "estimate"),
                                cost_per_public_market_month=PUBLIC_REFRESH,
                                effective_markets=Range(3000, 10000, 30000, "estimate"),
                                cost_per_customer_market_month=WEEKLY_TRACKING, start_markets=200),
        your_hours_per_month=(2, 6),
        setup_by_you="Stripe, a domain, hosting, and API keys for OpenAI, Perplexity, Google and Anthropic (1-2 hours).",
        risks=["New websites rarely get search traffic in year one (ahrefs-new-pages).",
               "BrightLocal, Localo, Local Falcon and Yext already sell local AI tracking.",
               "AI tool subscriptions under $50 churn fast (chartmogul-ai-churn)."],
    ),
    Idea(
        key="local-market-scan-apify",
        name="Local AI Market Scan on Apify",
        pitch="The market scan from before, listed on Apify Store: users scan a whole market and pay per business. "
              "You never contact anyone; buyers find it in the Store.",
        works_in="Apify Store's $0.79-per-business 'does ChatGPT recommend this business' check (apify-079), "
                 "and Google Maps business lists at a few dollars per 1,000.",
        scales_to="Whole markets at a time, at a few cents per business.",
        how_found="Apify Store search, Google results for Store pages, and AI agents through Apify's MCP server.",
        channels=[Channel("Apify Store", Range(15, 50, 200, "estimate; apify-payouts"), Range(2, 4, 8, "estimate"),
                          fixed(1.0, "every user pays per use"), share(0.3, 0.45, 0.6, "estimate"),
                          no_traction_share=MARKETPLACE_TRICKLE)],
        price=Range(8, 20, 60, "estimate: spend per active user per month"),
        churn=share(0.3, 0.45, 0.6, "estimate: many Store users run a tool once"),
        platform_fee=APIFY_FEE,
        cost_share=share(0.25, 0.35, 0.45, "api-prices: AI answers are about a third of the price"),
        fixed_monthly=Range(1, 10, 30, "estimate"),
        build_months=Range(0.5, 0.8, 1.2, "estimate"),
        your_hours_per_month=(1, 3),
        setup_by_you="Apify signup (already planned) and AI API keys saved as Apify secrets.",
        risks=["Its buyers are mostly agencies who use the lists to pitch businesses.",
               "Others can copy it; a $0.79 check already exists."],
    ),
    Idea(
        key="shopping-ai-rank",
        name="AI Shopping Rank (Shopify app)",
        pitch="A Shopify app that shows merchants which products ChatGPT, Perplexity and Gemini recommend for "
              "their shoppers' questions, where they're missing and why. It tracks each question once and shares "
              "the result with every merchant in that category.",
        works_in="Brand AI visibility tracking at $99-489/mo (profound, otterly, peec).",
        scales_to="1.18M US Shopify stores (shopify-stores); about 50M ChatGPT shopping queries a day.",
        how_found="Shopify App Store search ('ChatGPT', 'AI search', 'AI visibility'), plus free category pages.",
        channels=[
            Channel("Shopify App Store", Range(60, 200, 800, "estimate"), Range(3, 5, 9, "estimate"),
                    share(0.04, 0.09, 0.18, "estimate from fps-conversion: trial to paid 18.2%"),
                    share(0.2, 0.3, 0.45, "shopify-ai-apps: crowded category"),
                    no_traction_share=MARKETPLACE_TRICKLE),
            Channel("search: category pages", Range(1, 5, 20, "ahrefs-zero-traffic; estimate"), SEO_RAMP,
                    share(0.0005, 0.0015, 0.004, "estimate"), NEW_SITE_SEARCH, no_traction_share=SEARCH_TRICKLE,
                    per_public_market=True),
        ],
        price=Range(19, 29, 59, "otterly $29 entry; estimate"),
        churn=share(0.05, 0.08, 0.13, "recurly-churn; chartmogul-ai-churn"),
        platform_fee=0.0,
        cost_per_customer=Range(0.3, 0.8, 2, "estimate: hosting, email, storage"),
        cost_per_visitor=Range(0.05, 0.2, 0.6, "api-prices: a free install gets one snapshot from shared data"),
        fixed_monthly=Range(30, 60, 150, "estimate: app hosting and database"),
        upfront=Range(0, 50, 150, "estimate"),
        build_months=Range(1.2, 1.8, 2.8, "estimate, including app review"),
        ads=Ads(Range(2, 4, 9, "estimate: Shopify App Store ads"),
                share(0.008, 0.018, 0.04, "estimate"), monthly_budget=600, test_budget=300),
        measurement=Measurement(public_markets=Range(150, 400, 1200, "estimate: pages are a side channel here"),
                                cost_per_public_market_month=PUBLIC_REFRESH,
                                effective_markets=Range(2000, 5000, 12000,
                                                        "estimate: product categories whose questions merchants share"),
                                cost_per_customer_market_month=Range(2.5, 4.6, 8,
                                                                     "api-prices: 10 questions x 3 engines x 2 samples weekly"),
                                start_markets=150),
        your_hours_per_month=(3, 8),
        setup_by_you="Shopify Partner account, hosting, AI API keys (about 2 hours).",
        risks=["Crowded AI-SEO app category (shopify-ai-apps).",
               "OpenAI scaled back Instant Checkout (chatgpt-shopping).",
               "Shopify could build this itself."],
    ),
    Idea(
        key="apify-launch",
        name="Launch the 5 Apify tools we built",
        pitch="Publish the five finished AI-readiness tools on Apify Store, priced per result.",
        works_in="Apify Store pays about $1.4M a month to about 3,000 developers (apify-payouts).",
        scales_to="Apify's users and AI agents buying tools on their own (apify-x402).",
        how_found="Apify Store search, Google results for Store pages, AI agents.",
        channels=[Channel("Apify Store", Range(10, 40, 150, "estimate; apify-payouts"), Range(2, 4, 8, "estimate"),
                          fixed(1.0), share(0.3, 0.45, 0.6, "apify-ai-checkers: 6+ similar tools"),
                          no_traction_share=MARKETPLACE_TRICKLE)],
        price=Range(2, 5, 15, "estimate: $0.003-0.05 per result"),
        churn=share(0.35, 0.5, 0.65, "estimate"),
        platform_fee=APIFY_FEE,
        cost_share=share(0.05, 0.1, 0.15, "estimate: compute"),
        build_months=Range(0.1, 0.25, 0.5, "already built"),
        your_hours_per_month=(0.5, 2),
        setup_by_you="Apify signup, token in the environment settings, payouts (the existing GO_LIVE list).",
        risks=["At least 6 similar AI crawler checkers already on the Store (apify-ai-checkers)."],
    ),
    Idea(
        key="apify-factory",
        name="Apify tool factory (30-60 tools)",
        pitch="Keep adding tools in small, underserved niches, built on stable public data "
              "(official APIs, published standards), so they rarely break.",
        works_in="ParseForge: 1,805 tools, 5.1K monthly users in about 14 months; its first tool makes $1k/mo "
                 "(parseforge). Another developer reached 855 monthly users with 98 tools (apify-98).",
        scales_to="Many niches at once, sold to people and to AI agents.",
        how_found="Apify Store search, Google, AI agents.",
        channels=[Channel("Apify Store", Range(60, 250, 900, "parseforge / apify-98, scaled to 30-60 tools"),
                          Range(6, 10, 15, "estimate: tools are added over a year"), fixed(1.0),
                          share(0.45, 0.6, 0.75, "estimate: many small bets"), no_traction_share=MARKETPLACE_TRICKLE)],
        price=Range(3, 7, 20, "estimate"),
        churn=share(0.35, 0.5, 0.65, "estimate"),
        platform_fee=APIFY_FEE,
        cost_share=share(0.08, 0.12, 0.2, "estimate: compute"),
        fixed_monthly=Range(1, 20, 50, "estimate"),
        build_months=Range(0.5, 1, 1.5, "estimate"),
        your_hours_per_month=(3, 10),
        setup_by_you="Apify signup; then opening a Claude session when a tool needs a fix or a new batch.",
        risks=["AI-built tool factories are flooding the Store (parseforge ships 13+ a week).",
               "Upkeep grows with the number of tools (apify-98: 15-20 hours a week for 98 tools)."],
    ),
    Idea(
        key="ai-rights-checker",
        name="AI training opt-out checker (Apify)",
        pitch="Check every URL in a dataset for AI-training opt-outs (robots.txt, TDMRep, ai.txt, noai, "
              "Content-Signal) with an evidence log, for EU AI Act compliance.",
        works_in="Site-level AI crawler checkers on Apify (apify-ai-checkers).",
        scales_to="Everyone collecting web data for AI, which the EU has required to honor opt-outs, "
                  "with fines, since August 2026.",
        how_found="Apify Store search, Google, AI agents.",
        channels=[Channel("Apify Store", Range(5, 25, 100, "estimate"), Range(2, 4, 8, "estimate"), fixed(1.0),
                          share(0.25, 0.4, 0.55, "apify-ai-checkers: domain-level competitors exist"),
                          no_traction_share=MARKETPLACE_TRICKLE)],
        price=Range(10, 25, 100, "estimate: dataset builders check many URLs"),
        churn=share(0.3, 0.45, 0.6, "estimate"),
        platform_fee=APIFY_FEE,
        cost_share=share(0.08, 0.1, 0.15, "estimate"),
        build_months=Range(0.4, 0.7, 1, "estimate"),
        your_hours_per_month=(0.5, 2),
        setup_by_you="Apify signup.",
        risks=["Big AI labs build this themselves.", "Several domain-level checkers exist already."],
    ),
    Idea(
        key="ai-visibility-index",
        name="Public AI Visibility Index (website)",
        pitch="Free public grades for the top websites on how well AI can see them, "
              "earning from display ads and from sending visitors to the paid tools.",
        works_in="BuiltWith ($14M a year, mostly from search) and HubSpot's Website Grader (builtwith, hubspot-grader).",
        scales_to="Every major website.",
        how_found="Search, press, and shared grades.",
        channels=[Channel("search and press", Range(3000, 15000, 80000, "estimate"), SEO_RAMP, fixed(1.0),
                          NEW_SITE_SEARCH, no_traction_share=SEARCH_TRICKLE)],
        price=Range(0.002, 0.006, 0.015, "estimate: $2-15 earned per 1,000 visits"),
        churn=fixed(1.0, "revenue per visit"),
        platform_fee=0.0,
        fixed_monthly=Range(5, 20, 60, "estimate: crawling and hosting"),
        build_months=Range(0.5, 1, 1.5, "estimate"),
        your_hours_per_month=(0.5, 2),
        setup_by_you="A GitHub token and turning on GitHub Pages; a domain (optional).",
        risks=["New-site search base rates (ahrefs-new-pages).", "Little money per visitor."],
    ),
    Idea(
        key="ai-tracker-ads",
        name="Per-business AI tracker on ads",
        pitch="A self-serve 'does AI recommend my business' tracker, grown with Google Ads. "
              "Each customer's questions are run separately.",
        works_in="Otterly from $29/mo, 30,000+ users (otterly).",
        scales_to="Small businesses everywhere.",
        how_found="Google Ads (kept only if they pay back) and search.",
        channels=[Channel("search: free check", Range(1000, 4000, 15000, "estimate"), Range(6, 9, 14, "ahrefs-new-pages"),
                          share(0.004, 0.009, 0.02, "fps-conversion"),
                          share(0.08, 0.15, 0.25, "estimate: free tools from HubSpot and Semrush rank first"),
                          no_traction_share=SEARCH_TRICKLE)],
        price=Range(19, 29, 49, "otterly"),
        churn=SAAS_CHURN,
        platform_fee=STRIPE, fee_per_payment=STRIPE_FIXED,
        cost_per_customer=Range(1.5, 3.5, 8, "api-prices: 15 prompts x 3 engines weekly"),
        cost_per_visitor=Range(0.005, 0.015, 0.04, "api-prices: each free check runs new AI answers"),
        fixed_monthly=Range(30, 60, 150, "estimate"),
        upfront=Range(50, 100, 200, "estimate"),
        build_months=Range(1, 1.3, 2, "estimate"),
        ads=Ads(B2B_CPC, TRIAL_TO_PAID, monthly_budget=1000, test_budget=400),
        your_hours_per_month=(2, 6),
        setup_by_you="Stripe, domain, hosting, AI API keys, Google Ads account.",
        risks=["Dozens of competitors, including free ones.", "High churn."],
    ),
    Idea(
        key="grants-finder",
        name="Grant finder for small businesses",
        pitch="AI-matched grant alerts for small businesses, on programmatic pages by state and industry.",
        works_in="GrantWatch ($49 per 30 days, about 342k visits a month); Instrumentl (4,500+ customers "
                 "from $299/mo) (grantwatch, instrumentl).",
        scales_to="36.2M US small businesses (us-businesses).",
        how_found="Search ('small business grants' and long-tail pages).",
        channels=[Channel("search", Range(2000, 10000, 60000, "grantwatch traffic as a ceiling; estimate"),
                          Range(8, 12, 18, "ahrefs-new-pages"), share(0.001, 0.003, 0.008, "estimate"),
                          share(0.06, 0.12, 0.2, "ahrefs-new-pages; results full of SBA, NerdWallet, GrantWatch"),
                          no_traction_share=SEARCH_TRICKLE)],
        price=Range(9, 15, 29, "opengrants $9/mo; grantwatch"),
        churn=share(0.12, 0.2, 0.35, "grantwatch sells 7- and 30-day passes"),
        platform_fee=STRIPE, fee_per_payment=STRIPE_FIXED,
        cost_per_customer=Range(0.2, 0.5, 1, "estimate"),
        fixed_monthly=Range(50, 150, 400, "estimate: collecting grant data"),
        upfront=Range(50, 100, 300, "estimate"),
        build_months=Range(1.5, 2, 3, "estimate"),
        ads=Ads(Range(2, 4, 8, "estimate"), share(0.003, 0.008, 0.02, "estimate"), monthly_budget=500, test_budget=300),
        your_hours_per_month=(4, 12),
        setup_by_you="Stripe, domain, hosting.",
        risks=["Grant scams make buyers wary.", "Data upkeep across thousands of sources."],
    ),
    Idea(
        key="gov-contract-alerts",
        name="Government contract alerts",
        pitch="AI-matched federal, state and local bid alerts for small contractors.",
        works_in="GovTribe from $1,350/yr, HigherGov from $500/yr, RFPMart from $35/mo (govcon-prices).",
        scales_to="674,000+ SAM.gov registrants; $183.5B a year of small-business federal awards (sam-gov).",
        how_found="Search (pages by industry code and state), Google Ads when they pay back.",
        channels=[Channel("search", Range(1500, 8000, 40000, "estimate"), Range(8, 12, 18, "ahrefs-new-pages"),
                          share(0.002, 0.005, 0.012, "fps-conversion, lowered for long-tail pages"),
                          share(0.08, 0.15, 0.25, "govcon-prices: many new AI entrants in 2026"),
                          no_traction_share=SEARCH_TRICKLE)],
        price=Range(29, 49, 99, "govcon-prices"),
        churn=share(0.03, 0.045, 0.08, "recurly-churn"),
        platform_fee=STRIPE, fee_per_payment=STRIPE_FIXED,
        cost_per_customer=Range(0.5, 1.5, 4, "estimate"),
        fixed_monthly=Range(50, 150, 400, "estimate: state and local bid sources"),
        upfront=Range(50, 100, 300, "estimate"),
        build_months=Range(1.5, 2.5, 3.5, "estimate"),
        ads=Ads(Range(4, 9, 20, "wordstream-cpc; estimate for crowded keywords"),
                share(0.007, 0.015, 0.035, "fps-conversion"), monthly_budget=1500, test_budget=500),
        your_hours_per_month=(3, 10),
        setup_by_you="Stripe, domain, hosting, SAM.gov API key, Google Ads account.",
        risks=["Crowded with established and new AI tools.", "State and local bid sources break often."],
    ),
    Idea(
        key="ai-photo-product",
        name="Consumer AI photo product on ads",
        pitch="An AI headshot-style photo product in a new vertical, sold one time, grown with Meta ads and search.",
        works_in="AI headshots: Aragon about $10M ARR, HeadshotPro about $300k a month, PhotoAI $100k+ a month (headshots).",
        scales_to="Consumers and professionals.",
        how_found="Meta ads (kept only if they pay back) and search.",
        channels=[Channel("search", Range(5000, 30000, 150000, "estimate"), Range(6, 10, 15, "estimate"),
                          share(0.008, 0.015, 0.03, "estimate"),
                          share(0.04, 0.08, 0.15, "headshots: a crowded category since 2023"),
                          no_traction_share=SEARCH_TRICKLE)],
        price=Range(25, 35, 49, "headshots: HeadshotPro $29-59"),
        churn=fixed(1.0, "one-time purchase"),
        platform_fee=STRIPE, fee_per_payment=STRIPE_FIXED,
        cost_per_customer=Range(1, 2, 4, "estimate: GPU time"),
        fixed_monthly=Range(30, 80, 200, "estimate"),
        upfront=Range(100, 300, 800, "estimate"),
        build_months=Range(0.8, 1.2, 2, "estimate"),
        ads=Ads(Range(0.6, 1.2, 2.5, "estimate"), share(0.015, 0.028, 0.05, "meta-cpa: $35-55 per purchase"),
                monthly_budget=2000, test_budget=500, payback_factor=1.2),
        your_hours_per_month=(5, 15),
        setup_by_you="Stripe, domain, hosting, GPU API account, Meta ads account; ad testing needs your review.",
        risks=["Median Meta return on ad spend is about 0.3-2x (meta-cpa).", "Crowded since 2023; refunds."],
    ),
    Idea(
        key="shopify-ai-seo-app",
        name="Shopify AI-SEO app (llms.txt, schema)",
        pitch="A Shopify app that fixes a store for AI search: llms.txt, product schema, crawler access.",
        works_in="Booster, 4.9★ from 5,226 reviews, with AI-search features (shopify-ai-apps).",
        scales_to="1.18M US Shopify stores (shopify-stores).",
        how_found="Shopify App Store search.",
        channels=[Channel("Shopify App Store", Range(60, 200, 800, "estimate"), Range(3, 5, 9, "estimate"),
                          share(0.03, 0.07, 0.14, "estimate"),
                          share(0.12, 0.2, 0.3, "shopify-ai-apps: many llms.txt apps"),
                          no_traction_share=MARKETPLACE_TRICKLE)],
        price=Range(9, 15, 29, "estimate"),
        churn=share(0.06, 0.09, 0.14, "estimate"),
        platform_fee=0.0,
        cost_per_customer=Range(0.1, 0.3, 0.8, "estimate"),
        fixed_monthly=Range(20, 40, 100, "estimate"),
        build_months=Range(1, 1.5, 2.2, "estimate"),
        your_hours_per_month=(3, 8),
        setup_by_you="Shopify Partner account, hosting.",
        risks=["Commodity features; Yoast-style tools give them away."],
    ),
]
