/**
 * marketOdds.js — real market probabilities, de-vigging, and edge / EV / Kelly.
 *
 * Ported from commodus67/mlb-playoff-odds-monte-carlo, trimmed to Kalshi only.
 * The Polymarket adapter that lives in the MLB copy is deliberately not here:
 * Polymarket lists no NHL qualification market, and shipping an unused adapter
 * whose search endpoint silently ignores its query is worse than shipping none.
 *
 * Source: https://external-api.kalshi.com/trade-api/v2 — public, no API key,
 * no auth, CFTC-regulated exchange. A contract price IS a probability, so there
 * is no conversion guesswork, and "model vs market" reads as statistics rather
 * than as betting tips.
 *
 * Zero dependencies. Node 18+ (global fetch). ES module.
 */

const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. FETCHING
 * ──────────────────────────────────────────────────────────────────────────── */

async function getJSON(url, { timeoutMs = 15000, retries = 2 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
            clearTimeout(timer);
            if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
            if (!res.ok) return null; // 404 etc. — market simply not listed
            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            if (attempt === retries) {
                console.warn(`[marketOdds] giving up on ${url}: ${err.message}`);
                return null;
            }
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
    }
    return null;
}

/** All open markets in a series, paged. */
async function fetchKalshiSeries(seriesTicker) {
    const data = await getJSON(`${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=open&limit=200`);
    if (!data?.markets?.length) return [];
    return data.markets.map(toKalshiOutcome).filter(Boolean);
}

/**
 * One event (a single race), with its markets.
 *
 * The nested form is asked for first because it is one round trip, but Kalshi
 * does not always populate it. Falling back to the flat /markets query keeps a
 * missing `markets` array from looking like an unlisted race.
 */
async function fetchKalshiEvent(eventTicker) {
    const data = await getJSON(`${KALSHI_BASE}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
    let markets = data?.event?.markets ?? data?.markets ?? [];
    if (!markets.length) {
        const flat = await getJSON(`${KALSHI_BASE}/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`);
        markets = flat?.markets ?? [];
    }
    return markets.map(toKalshiOutcome).filter(Boolean);
}

function toKalshiOutcome(m) {
    // Prefer the mid-price: the last trade can be stale, and the bid/ask straddle
    // fair value. Kalshi serves these as decimal strings, not numbers.
    const bid = num(m.yes_bid_dollars);
    const ask = num(m.yes_ask_dollars);
    const last = num(m.last_price_dollars);

    let price = null;
    if (bid > 0 && ask > 0) price = (bid + ask) / 2;
    else if (last > 0) price = last;
    else if (ask > 0) price = ask;
    if (price === null || price <= 0 || price >= 1) return null;

    return {
        source: 'kalshi',
        label: m.yes_sub_title || m.no_sub_title || m.title || m.ticker,
        ticker: m.ticker,
        price,
        bid,
        ask,
        spread: bid > 0 && ask > 0 ? ask - bid : null,
        volume: num(m.volume_fp),
        openInterest: num(m.open_interest_fp),
        liquidity: num(m.liquidity_dollars),
    };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* ────────────────────────────────────────────────────────────────────────────
 * 2. DE-VIGGING — the step almost nobody does
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * CRITICAL DISTINCTION — get this wrong and the output is garbage.
 *
 *  A) MUTUALLY EXCLUSIVE races (exactly one winner):
 *     "Atlantic Division Winner", "Stanley Cup Champion".
 *     Quoted prices sum to MORE than 1. The excess is the house margin.
 *     Divide through by the total to recover true probabilities.
 *
 *  B) INDEPENDENT binaries (many can resolve YES):
 *     "Will X qualify for the playoffs" — 16 of 32 make it, so prices sum to
 *     about 16. There is NO overround to remove. Normalising these would divide
 *     every probability by sixteen and manufacture enormous fake edges across
 *     the whole field. The margin lives in the bid-ask spread instead, and the
 *     mid price is already the fair estimate.
 *
 * Pass `exclusive: false` for category B, with `targetSum` set to the number of
 * slots, and the field is sanity-checked — the cheapest way to catch a wrong
 * ticker or a half-returned page.
 */
function devig(outcomes, { method = 'proportional', exclusive = true, targetSum = null } = {}) {
    const valid = outcomes.filter((o) => o.price > 0 && o.price < 1);
    if (!valid.length) return [];

    const total = valid.reduce((s, o) => s + o.price, 0);

    if (!exclusive) {
        if (targetSum && Math.abs(total - targetSum) > Math.max(1, targetSum * 0.25)) {
            console.warn(`[marketOdds] prices sum to ${total.toFixed(2)} but expected ~${targetSum}. Field may be incomplete or the ticker may be wrong.`);
        }
        return valid.map((o) => ({ ...o, marketProbability: clamp(o.price), overround: null, devigMethod: 'none (independent binaries)', fieldSum: total }));
    }

    const overround = total - 1;
    if (overround < -0.05) {
        console.warn(`[marketOdds] exclusive field sums to ${total.toFixed(3)}, below 1. Outcomes are probably missing — check the ticker returned the full race.`);
    }

    if (method === 'power' && total > 1.0001) {
        const k = solvePowerK(valid.map((o) => o.price));
        return valid.map((o) => ({ ...o, marketProbability: clamp(o.price ** k), overround, devigMethod: 'power', fieldSum: total }));
    }

    return valid.map((o) => ({ ...o, marketProbability: clamp(o.price / total), overround, devigMethod: 'proportional', fieldSum: total }));
}

/** Bisection for k such that sum(p_i^k) = 1. */
function solvePowerK(prices) {
    const f = (k) => prices.reduce((s, p) => s + p ** k, 0) - 1;
    let lo = 0.5;
    let hi = 3.0;
    if (f(lo) * f(hi) > 0) return 1;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
}

/** Two-way sportsbook fallback, if a bookmaker line is ever supplied. */
function americanToImplied(odds) {
    const o = Number(odds);
    if (!Number.isFinite(o) || o === 0) return null;
    return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

const clamp = (p) => Math.min(0.9999, Math.max(0.0001, p));

/* ────────────────────────────────────────────────────────────────────────────
 * 3. FEES, EDGE, EV, SIZING
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Kalshi charges a fee that PEAKS AT MID-PRICE, unlike a flat commission:
 *
 *     fee = ceil_to_cent( rate * contracts * price * (1 - price) )
 *
 * Two details that are easy to get wrong:
 *
 *  1. THE ROUNDING IS PER ORDER, NOT PER CONTRACT. Rounding a single contract up
 *     to a whole cent badly overstates the cost at extreme prices: at $0.90 the
 *     true per-contract fee is 0.07 x 0.90 x 0.10 = $0.0063, but rounding one
 *     contract up gives $0.01 — 59% too high. Use `feePerContract` for economics
 *     and `kalshiFee` only for the charge on a real order.
 *  2. The consequence traders miss: a three-point edge on a coin-flip contract
 *     can be NEGATIVE after fees, while the same three points on a 0.90 contract
 *     survives comfortably.
 *
 * The 0.07 coefficient is the standard taker rate and covers sports. Resting
 * limit orders pay materially less — roughly a quarter — so assuming taker is
 * the conservative choice.
 */
function feePerContract(price, rate = 0.07) {
    return rate * price * (1 - price);
}

/** Actual charge on a real order — rounded up to the next cent, per order. */
function kalshiFee(price, contracts = 1, rate = 0.07) {
    const raw = rate * contracts * price * (1 - price);
    return Math.ceil(raw * 100) / 100;
}

/** Expected value per contract, net of fees. */
function expectedValue(modelProbability, price, { feeRate = 0.07 } = {}) {
    const fee = feePerContract(price, feeRate);
    const grossEV = modelProbability * (1 - price) - (1 - modelProbability) * price;
    const netEV = grossEV - fee;
    return { grossEV, fee, netEV, roi: price > 0 ? netEV / price : 0, breakEvenProbability: price + fee };
}

/**
 * Fractional Kelly. Full Kelly is mathematically optimal for growth and
 * practically reckless — it assumes your probability is exactly right. On a
 * model it is not. Quarter-Kelly is the standard defensive choice.
 */
function kellyStake(modelProbability, price, { fraction = 0.25, bankroll = 1000, maxPerPositionPct = 0.02, feeRate = 0.07 } = {}) {
    const { netEV } = expectedValue(modelProbability, price, { feeRate });
    if (netEV <= 0) return { fractionOfBankroll: 0, stake: 0, contracts: 0, reason: 'negative EV after fees' };

    const b = (1 - price) / price;
    const kellyFull = (modelProbability * b - (1 - modelProbability)) / b;
    if (kellyFull <= 0) return { fractionOfBankroll: 0, stake: 0, contracts: 0, reason: 'no Kelly edge' };

    const uncapped = kellyFull * fraction;
    const sized = Math.min(uncapped, maxPerPositionPct);
    const stake = sized * bankroll;
    return {
        fractionOfBankroll: round(sized, 5),
        fractionUncapped: round(uncapped, 5),
        positionCapBinding: uncapped > maxPerPositionPct,
        stake: round(stake, 2),
        contracts: Math.floor(stake / price),
        kellyFull: round(kellyFull, 5),
        reason: null,
    };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. MATCHING MODEL OUTPUT TO MARKET OUTCOMES
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ESPN and Kalshi agree on all 32 NHL club names, verified against both feeds,
 * so these aliases are defensive rather than load-bearing: Kalshi writes
 * "Montréal Canadiens" on the qualification market and "Montreal Canadiens" on
 * the division market, and a club that gets renamed mid-cycle (Arizona became
 * Utah, and Utah picked up the Mammoth name a year later) should keep matching
 * whichever feed updates second.
 */
const ALIASES = {
    'montreal canadiens': ['montreal', 'canadiens', 'mtl'],
    'st louis blues': ['st louis', 'saint louis blues', 'blues', 'stl'],
    'utah mammoth': ['utah', 'utah hockey club', 'arizona coyotes', 'uta'],
    'vegas golden knights': ['las vegas golden knights', 'golden knights', 'vgk'],
    'new jersey devils': ['new jersey', 'devils', 'nj', 'njd'],
    'new york rangers': ['ny rangers', 'rangers', 'nyr'],
    'new york islanders': ['ny islanders', 'islanders', 'nyi'],
    'los angeles kings': ['la kings', 'kings', 'lak'],
    'san jose sharks': ['san jose', 'sharks', 'sjs'],
    'tampa bay lightning': ['tampa bay', 'lightning', 'tbl'],
    'columbus blue jackets': ['columbus', 'blue jackets', 'cbj'],
    'washington capitals': ['washington', 'capitals', 'wsh'],
    'winnipeg jets': ['winnipeg', 'jets', 'wpg'],
    'anaheim ducks': ['anaheim', 'ducks', 'ana'],
};

function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents: Montréal -> Montreal
        .replace(/\b(fc|cf|afc|sc|ac|cd|club|the)\b/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The alias table is normalised once at load, not compared raw. Writing
 * "Utah Hockey Club" in the table and looking up "Utah Hockey Club" used to
 * miss: normalizeName strips the word "club", so the lookup key was
 * "utah hockey" while the table still held "utah hockey club".
 */
const NORMALIZED_ALIASES = new Map(
    Object.entries(ALIASES).map(([canonical, list]) => [normalizeName(canonical), list.map(normalizeName)]),
);

function matchOutcome(teamName, outcomes) {
    const target = normalizeName(teamName);
    if (!target) return null;

    let hit = outcomes.find((o) => normalizeName(o.label) === target);
    if (hit) return hit;

    const aliases = NORMALIZED_ALIASES.get(target) ?? [];
    const expanded = [target, ...aliases];
    for (const [canonical, list] of NORMALIZED_ALIASES) {
        if (list.includes(target)) expanded.push(canonical, ...list);
    }

    hit = outcomes.find((o) => expanded.includes(normalizeName(o.label)));
    if (hit) return hit;

    // Last resort: containment, but only when unambiguous.
    const partial = outcomes.filter((o) => {
        const l = normalizeName(o.label);
        return expanded.some((e) => e.length >= 4 && (l.includes(e) || e.includes(l)));
    });
    return partial.length === 1 ? partial[0] : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. MAIN ENTRY POINT
 * ──────────────────────────────────────────────────────────────────────────── */

function buildValueBets(projections, outcomes, opts = {}) {
    const {
        devigMethod = 'proportional',
        exclusive = true,
        targetSum = null,
        minEdge = 0.04,
        maxSpread = 0.05,

        // TRADABILITY GATE. Kalshi returns liquidity_dollars = "0.0000" even on
        // deeply traded markets, so gating on that field alone rejects everything.
        // A market counts as tradable if ANY depth signal clears.
        minOpenInterest = 1000,
        minVolume = 500,
        minLiquidity = 500,
        feeRate = 0.07,
        bankroll = 1000,
        kellyFraction = 0.25,
        maxPerPositionPct = 0.02,
        maxTotalExposurePct = 0.06,
    } = opts;

    const priced = devig(outcomes, { method: devigMethod, exclusive, targetSum });
    if (!priced.length) {
        return { rows: [], meta: { status: 'no_market_data', matched: 0, note: 'No open market found for this race.' } };
    }

    // FIELD INTEGRITY. If an exclusive field comes back incomplete, proportional
    // de-vigging divides by a total below 1 and INFLATES every probability. The
    // numbers look plausible and are entirely wrong. A consumer of the dataset
    // never sees stderr, so the verdict travels in the output instead: when the
    // field is suspect, no row is allowed to claim VALUE.
    const { fieldSum } = priced[0];
    let fieldIntegrity = 'ok';
    let integrityNote = null;

    if (exclusive) {
        if (fieldSum < 0.9 || fieldSum > 1.35) {
            fieldIntegrity = 'suspect';
            integrityNote = `Exclusive field sums to ${fieldSum.toFixed(3)}, outside the plausible 0.90-1.35 range. The outcome list is probably incomplete.`;
        }
    } else if (targetSum) {
        const tolerance = Math.max(1, targetSum * 0.25);
        if (Math.abs(fieldSum - targetSum) > tolerance) {
            fieldIntegrity = 'suspect';
            integrityNote = `Field sums to ${fieldSum.toFixed(2)} against an expected ${targetSum}. The outcome list is probably incomplete.`;
        }
    }

    // Every row carries the SAME keys regardless of outcome. Ragged rows break
    // anything that loads the dataset as a table.
    const emptyRow = (team, modelProbability, recommendation, note) => ({
        team,
        modelProbability,
        marketPrice: null,
        marketProbability: null,
        edge: null,
        grossEV: null,
        estimatedFee: null,
        orderFee: 0,
        netEV: null,
        breakEvenProbability: null,
        suggestedStake: 0,
        suggestedContracts: 0,
        suggestedFractionOfBankroll: 0,
        kellyFractionUncapped: 0,
        positionCapBinding: false,
        cappedByPortfolioLimit: false,
        recommendation,
        note,
        marketSource: null,
        marketTicker: null,
        marketLiquidity: null,
        marketOpenInterest: null,
        marketVolume: null,
        marketSpread: null,
    });

    // One contract can back only one projection. If the alias table over-matches,
    // silently sizing both would double-count exposure against the portfolio cap.
    const claimed = new Set();

    const rows = projections.map((p) => {
        const raw = Number(p.probability);

        // A non-finite model probability makes every downstream comparison false,
        // including `edge < minEdge`, which would let a NaN row fall through to
        // VALUE — a buy signal manufactured from missing data. Reject it loudly.
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
            return emptyRow(p.team ?? null, null, 'NO_MODEL', 'Model probability missing or out of range — row excluded from sizing.');
        }

        const modelProbability = clamp(raw);
        const market = matchOutcome(p.team, priced);

        if (!market) return emptyRow(p.team, round(modelProbability, 4), 'NO_MARKET', 'No matching contract listed.');

        if (claimed.has(market.ticker)) {
            return emptyRow(p.team, round(modelProbability, 4), 'DUPLICATE_MATCH', `Resolved to contract ${market.ticker}, already claimed by an earlier projection. Excluded from sizing.`);
        }
        claimed.add(market.ticker);

        const edge = modelProbability - market.marketProbability;
        const ev = expectedValue(modelProbability, market.price, { feeRate });

        const hasDepth = (market.liquidity ?? 0) >= minLiquidity
            || (market.openInterest ?? 0) >= minOpenInterest
            || (market.volume ?? 0) >= minVolume;

        const spreadOK = market.spread === null || market.spread <= maxSpread;
        const tradable = hasDepth && spreadOK;

        let recommendation = 'PASS';
        let note = null;
        // Float tolerance: 0.60 - 0.55 evaluates to 0.04999999999999993, so a
        // strict `<` rejects a row whose displayed edge is exactly the threshold.
        if (edge < minEdge - 1e-9) {
            note = `Edge ${pct(edge)} below the ${pct(minEdge)} threshold.`;
        } else if (ev.netEV <= 0) {
            note = `Edge ${pct(edge)} does not survive fees — needs ${pct(ev.breakEvenProbability)} to break even.`;
        } else if (!tradable) {
            recommendation = 'WATCH';
            note = !spreadOK
                ? `Positive edge but the spread is ${pct(market.spread)} — the mid price is not a real fill.`
                : `Positive edge but too thin (open interest ${round(market.openInterest, 0)}, volume ${round(market.volume, 0)}).`;
        } else if (fieldIntegrity === 'suspect') {
            recommendation = 'WATCH';
            note = `Edge ${pct(edge)} not actionable: ${integrityNote}`;
        } else {
            recommendation = 'VALUE';
        }

        const sizing = recommendation === 'VALUE'
            ? kellyStake(modelProbability, market.price, { fraction: kellyFraction, bankroll, maxPerPositionPct, feeRate })
            : { fractionOfBankroll: 0, stake: 0, contracts: 0 };

        return {
            team: p.team,
            modelProbability: round(modelProbability, 4),
            marketPrice: round(market.price, 4),
            marketProbability: round(market.marketProbability, 4),
            edge: round(edge, 4),
            grossEV: round(ev.grossEV, 4),
            estimatedFee: round(ev.fee, 4),
            orderFee: sizing.contracts > 0 ? kalshiFee(market.price, sizing.contracts, feeRate) : 0,
            netEV: round(ev.netEV, 4),
            breakEvenProbability: round(ev.breakEvenProbability, 4),
            suggestedStake: sizing.stake,
            suggestedContracts: sizing.contracts,
            suggestedFractionOfBankroll: sizing.fractionOfBankroll ?? 0,
            // Quarter-Kelly BEFORE the per-position cap. This is the field that
            // discriminates between a 15-point edge and a 6-point one — the capped
            // figure clips to maxPerPositionPct and goes flat across every row.
            kellyFractionUncapped: sizing.fractionUncapped ?? 0,
            positionCapBinding: sizing.positionCapBinding ?? false,
            cappedByPortfolioLimit: false,
            recommendation,
            note,
            marketSource: market.source,
            marketTicker: market.ticker,
            marketLiquidity: round(market.liquidity, 0),
            marketOpenInterest: round(market.openInterest, 0),
            marketVolume: round(market.volume, 0),
            marketSpread: market.spread === null ? null : round(market.spread, 4),
        };
    });

    // Portfolio cap: trim stakes so total exposure fits the budget. A trimmed row
    // KEEPS its VALUE recommendation — budget exhaustion is not a verdict on the
    // bet. The edge is real; only the sizing is constrained.
    const cap = maxTotalExposurePct * bankroll;
    const valueRows = rows.filter((r) => r.recommendation === 'VALUE').sort((a, b) => b.netEV - a.netEV);
    let running = 0;
    let trimmedCount = 0;
    for (const r of valueRows) {
        if (running + r.suggestedStake > cap) {
            const remaining = Math.max(0, cap - running);
            r.suggestedStake = round(remaining, 2);
            r.suggestedContracts = Math.floor(remaining / r.marketPrice);
            r.cappedByPortfolioLimit = true;
            trimmedCount++;
            if (r.suggestedContracts === 0) {
                r.note = `Edge qualifies, but the ${pct(maxTotalExposurePct)} portfolio cap is exhausted at this bankroll. Raise bankroll to size this position.`;
            }
            // orderFee is a function of contract count, so it has to be recomputed
            // after trimming, or a row reports 0 contracts with a non-zero fee.
            r.orderFee = r.suggestedContracts > 0 ? kalshiFee(r.marketPrice, r.suggestedContracts, feeRate) : 0;
        }
        running += r.suggestedStake;
    }

    rows.sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));

    return {
        rows,
        meta: {
            status: 'ok',
            retrievedAt: new Date().toISOString(),
            marketSource: priced[0].source,
            marketType: exclusive ? 'mutually_exclusive' : 'independent_binaries',
            devigMethod: priced[0].devigMethod,
            overround: round(priced[0].overround, 4),
            fieldSum: round(priced[0].fieldSum, 3),
            expectedFieldSum: exclusive ? 1 : targetSum,
            fieldIntegrity,
            integrityNote,
            outcomesListed: priced.length,
            matched: rows.filter((r) => r.marketProbability !== null).length,
            valueCount: rows.filter((r) => r.recommendation === 'VALUE').length,
            cappedByPortfolioLimit: trimmedCount,
            totalSuggestedExposure: round(running, 2),
            portfolioCap: round(cap, 2),
            thresholds: { minEdge, maxSpread, minOpenInterest, minVolume, minLiquidity, feeRate, kellyFraction },
        },
    };
}

function round(v, d) { return v === null || v === undefined ? null : Number(Number(v).toFixed(d)); }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }

export {
    fetchKalshiSeries,
    fetchKalshiEvent,
    devig,
    americanToImplied,
    kalshiFee,
    feePerContract,
    expectedValue,
    kellyStake,
    matchOutcome,
    normalizeName,
    buildValueBets,
};
