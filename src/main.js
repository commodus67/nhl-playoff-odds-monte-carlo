import { Actor, log } from 'apify';
import { fetchKalshiEvent, buildValueBets } from './marketOdds.js';
import {
    PYTHAGOREAN_EXPONENT,
    MIN_SEASON_GAMES,
    round,
    normalizeName,
    defaultSeason,
    buildRatings,
    simulate,
} from './model.js';

/*
 * NHL Playoff Odds — Monte Carlo simulator with live Kalshi prices.
 * Data loading, market wiring and output shaping live here; the model itself
 * is in src/model.js so it can be tested without touching the network.
 */

const ESPN_HOST = 'https://site.api.espn.com';
const STANDINGS_PATH = '/apis/v2/sports/hockey/nhl/standings';
const schedulePath = (teamId) => `/apis/site/v2/sports/hockey/nhl/teams/${teamId}/schedule`;

const KALSHI_PLAYOFF_EVENT = (season) => `KXNHLPLAYOFF-${String(season).slice(-2)}`;
const KALSHI_DIVISION_EVENTS = (season) => ({
    'Atlantic Division': `KXNHLATLANTIC-${String(season).slice(-2)}`,
    'Metropolitan Division': `KXNHLMETROPOLITAN-${String(season).slice(-2)}`,
    'Central Division': `KXNHLCENTRAL-${String(season).slice(-2)}`,
    'Pacific Division': `KXNHLPACIFIC-${String(season).slice(-2)}`,
});

async function fetchJson(url, label) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${label} request failed with status ${res.status}`);
    return res.json();
}

function statValue(stats, wanted) {
    if (!Array.isArray(stats)) return null;
    const target = normalizeName(wanted);
    const hit = stats.find((s) => normalizeName(s?.name) === target);
    if (!hit) return null;
    const num = Number(hit.value ?? hit.displayValue);
    return Number.isFinite(num) ? num : null;
}

/* ── data loading ────────────────────────────────────────────────────────── */

/** With level=3 ESPN returns NHL -> conference -> division -> standings.entries. */
function collectEntries(node, conference, division, out) {
    const name = node?.name ?? null;
    const isConference = /conference/i.test(name ?? '');
    const nextConference = conference ?? (isConference ? name : null);
    const nextDivision = conference && !division ? name : division;

    const entries = node?.standings?.entries;
    if (Array.isArray(entries) && entries.length) {
        for (const entry of entries) {
            out.push({ entry, conference: nextConference, division: nextDivision ?? name });
        }
    }
    for (const child of node?.children ?? []) {
        collectEntries(child, nextConference, nextDivision, out);
    }
    return out;
}

/**
 * ESPN publishes the division tree for an upcoming season but leaves it empty
 * until the first game is played, so this can legitimately return zero teams.
 * The caller decides what to do about that rather than throwing here.
 */
async function fetchStandings(season) {
    const url = `${ESPN_HOST}${STANDINGS_PATH}?level=3&seasontype=2${season ? `&season=${season}` : ''}`;
    const data = await fetchJson(url, `Standings ${season ?? 'current'}`);

    return collectEntries(data, null, null, []).map(({ entry, conference, division }) => {
        const team = entry.team ?? {};
        const stats = entry.stats ?? [];
        const wins = statValue(stats, 'wins') ?? 0;
        const losses = statValue(stats, 'losses') ?? 0;
        const otLosses = statValue(stats, 'otLosses') ?? statValue(stats, 'overtimeLosses') ?? 0;
        const gamesPlayed = statValue(stats, 'gamesPlayed') ?? wins + losses + otLosses;
        // ESPN reuses the football field names: pointsFor/pointsAgainst are goals here.
        const goalsFor = statValue(stats, 'pointsFor') ?? 0;
        const goalsAgainst = statValue(stats, 'pointsAgainst') ?? 0;
        const points = statValue(stats, 'points') ?? 2 * wins + otLosses;

        return {
            id: String(team.id ?? ''),
            team: team.displayName ?? team.name ?? 'Unknown',
            abbreviation: team.abbreviation ?? '',
            conference: conference ?? 'Unknown Conference',
            division: division ?? 'Unknown Division',
            wins,
            losses,
            otLosses,
            points,
            gamesPlayed,
            goalsFor,
            goalsAgainst,
            goalDifferential: goalsFor - goalsAgainst,
            gamesRemaining: 0,
        };
    });
}

/** A team carried over from last season's table with its record wiped. */
function blankSlate(t) {
    return {
        ...t,
        wins: 0,
        losses: 0,
        otLosses: 0,
        points: 0,
        gamesPlayed: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifferential: 0,
        gamesRemaining: 0,
    };
}

async function loadRemainingGames(teams, season) {
    const now = Date.now();
    const known = new Set(teams.map((t) => t.id));
    const byId = new Map(teams.map((t) => [t.id, t]));
    const seen = new Set();
    const games = [];
    const chunkSize = 6;

    for (let i = 0; i < teams.length; i += chunkSize) {
        const slice = teams.slice(i, i + chunkSize);
        const payloads = await Promise.all(slice.map(async (t) => {
            const url = `${ESPN_HOST}${schedulePath(t.id)}?seasontype=2${season ? `&season=${season}` : ''}`;
            try {
                return await fetchJson(url, `Schedule for ${t.team}`);
            } catch (err) {
                log.warning(`Could not load the schedule for ${t.team}: ${err.message}`);
                return null;
            }
        }));

        for (const data of payloads) {
            for (const event of data?.events ?? []) {
                if (!event || seen.has(event.id)) continue;
                const competition = event?.competitions?.[0];
                if (!competition) continue;

                const type = competition.status?.type ?? event?.status?.type ?? {};
                if (type.completed === true) continue;
                if (type.name === 'STATUS_FINAL' || type.name === 'STATUS_CANCELED' || type.name === 'STATUS_POSTPONED') continue;

                const when = new Date(event.date).getTime();
                if (Number.isFinite(when) && when <= now) continue;

                const competitors = competition.competitors ?? [];
                const home = competitors.find((c) => c.homeAway === 'home');
                const away = competitors.find((c) => c.homeAway === 'away');
                if (!home?.team || !away?.team) continue;

                const homeId = String(home.team.id);
                const awayId = String(away.team.id);
                if (!known.has(homeId) || !known.has(awayId)) continue;

                seen.add(event.id);
                games.push({ homeId, awayId });
            }
        }
    }

    for (const g of games) {
        byId.get(g.homeId).gamesRemaining += 1;
        byId.get(g.awayId).gamesRemaining += 1;
    }

    log.info(`Loaded ${games.length} remaining games across the league.`);
    return games;
}

function buildManualMarketMap(rows) {
    const map = new Map();
    for (const row of rows ?? []) {
        if (!row?.team) continue;
        const market = String(row.market ?? 'playoff').toLowerCase();
        const p = Number(row.impliedProbability ?? row.probability);
        if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
        map.set(`${normalizeName(row.team)}|${market}`, p);
    }
    return map;
}

/* ── run ─────────────────────────────────────────────────────────────────── */

await Actor.init();

const input = (await Actor.getInput()) ?? {};

const ITERATIONS = Math.max(200, Math.min(Math.trunc(input.iterations ?? 20000), 200000));
const SEASON = input.season ? Math.trunc(input.season) : defaultSeason();
const PRIOR_SEASON = SEASON - 1;
const ARCHIVE_DATASET = typeof input.archiveToNamedDataset === 'string' ? input.archiveToNamedDataset.trim() : '';
const REGRESSION_GAMES = Math.max(0, input.regressionGames ?? 25);
const PYTHAG_WEIGHT = Math.min(1, Math.max(0, input.pythagoreanWeight ?? 0.6));
const HOME_ICE = input.homeIceAdvantage ?? 0.12;
const STRENGTH_UNCERTAINTY = Math.max(0, input.strengthUncertainty ?? 0.1);
const OVERTIME_PROBABILITY = Math.min(0.5, Math.max(0, input.overtimeProbability ?? 0.23));
const OVERTIME_DAMPING = Math.min(1, Math.max(0, input.overtimeDamping ?? 0.5));
const PRIOR_CARRYOVER = Math.min(1, Math.max(0, input.priorCarryover ?? 0.6));
const EDGE_THRESHOLD = input.edgeThreshold ?? 0.05;
const BANKROLL = Math.max(0, input.bankroll ?? 1000);
const MAX_PER_POSITION = Math.min(1, Math.max(0, input.maxPerPositionPct ?? 0.02));
const MAX_TOTAL_EXPOSURE = Math.min(1, Math.max(0, input.maxTotalExposurePct ?? 0.06));
const INCLUDE_DIVISION_MARKETS = input.includeDivisionMarkets !== false;
const MIN_GAMES_FOR_VALUE = Math.max(0, input.minGamesPlayedForValue ?? 10);
const MARKET_INPUT = Array.isArray(input.marketProbabilities) ? input.marketProbabilities : [];

/* Teams. Before the first puck drop ESPN serves an empty table for the season,
 * so the roster of clubs and the division map come from last season and every
 * record starts at zero. */
const currentStandings = await fetchStandings(SEASON).catch((err) => {
    log.warning(`Standings for ${SEASON} could not be read: ${err.message}`);
    return [];
});
const priorStandings = await fetchStandings(PRIOR_SEASON).catch((err) => {
    log.warning(`Standings for ${PRIOR_SEASON} could not be read: ${err.message}`);
    return [];
});

let preSeason = false;
let teams;
if (currentStandings.length) {
    teams = currentStandings;
} else if (priorStandings.length) {
    preSeason = true;
    teams = priorStandings.map(blankSlate);
    log.info(`ESPN has no ${SEASON} table yet, so the ${PRIOR_SEASON} club list and division map are used with every record at zero.`);
} else {
    throw new Error(`ESPN returned no NHL standings for ${SEASON} or ${PRIOR_SEASON}. Check the season parameter.`);
}
log.info(`Loaded ${teams.length} NHL teams for the ${SEASON - 1}-${String(SEASON).slice(-2)} season.`);

/* Pre-season prior. With no games played every team regresses to .500 and all 32
 * come out identical, so last season's Pythagorean is shrunk towards .500 and
 * used as the baseline the current record regresses to. */
const priorTalentById = new Map(
    priorStandings.filter((p) => p.gamesPlayed > 0).map((p) => {
        const pythag = p.goalsFor > 0 && p.goalsAgainst > 0
            ? p.goalsFor ** PYTHAGOREAN_EXPONENT / (p.goalsFor ** PYTHAGOREAN_EXPONENT + p.goalsAgainst ** PYTHAGOREAN_EXPONENT)
            : 0.5;
        const actual = p.gamesPlayed ? p.wins / p.gamesPlayed : 0.5;
        return [p.id, PYTHAG_WEIGHT * pythag + (1 - PYTHAG_WEIGHT) * actual];
    }),
);
if (PRIOR_CARRYOVER > 0 && !priorTalentById.size) {
    log.warning(`No ${PRIOR_SEASON} standings from ESPN, falling back to a flat .500 prior.`);
}
for (const t of teams) {
    const prior = priorTalentById.get(t.id);
    t.priorTalent = prior === undefined || PRIOR_CARRYOVER === 0 ? 0.5 : 0.5 + PRIOR_CARRYOVER * (prior - 0.5);
}
log.info(`Prior from ${PRIOR_SEASON} seeded for ${priorTalentById.size} teams, carryover ${PRIOR_CARRYOVER}.`);

const games = await loadRemainingGames(teams, SEASON);
if (!games.length) {
    log.warning('No remaining games found. The output reflects the standings as they stand.');
}

// Read the season length off the schedule rather than hardcoding it. The NHL went
// from 82 games to 84 in 2026-27, and a hardcoded 82 would have quietly reported
// two phantom games in progress for every club all season.
const seasonLength = Math.max(MIN_SEASON_GAMES, ...teams.map((t) => t.gamesPlayed + t.gamesRemaining));
log.info(`Season length read from the schedule: ${seasonLength} games per team.`);
const gamesInProgress = new Map(teams.map((t) => [t.id, Math.max(seasonLength - t.gamesPlayed - t.gamesRemaining, 0)]));

buildRatings(teams, { pythagoreanWeight: PYTHAG_WEIGHT, regressionGames: REGRESSION_GAMES });

log.info(`Running ${ITERATIONS} simulated seasons.`);
const sim = simulate(teams, games, ITERATIONS, {
    homeIceAdvantage: HOME_ICE,
    strengthUncertainty: STRENGTH_UNCERTAINTY,
    overtimeProbability: OVERTIME_PROBABILITY,
    overtimeDamping: OVERTIME_DAMPING,
});

/* ── market side ─────────────────────────────────────────────────────────── */

const manualMarket = buildManualMarketMap(MARKET_INPUT);
const playoffByTeam = new Map();
const divisionByTeam = new Map();
let marketMeta = null;
let marketSourceLabel = null;
let marketRetrievedAt = null;

if (manualMarket.size > 0) {
    marketSourceLabel = 'manual-input';
    marketRetrievedAt = new Date().toISOString();
    log.info(`Manual override: ${manualMarket.size} market probabilities supplied. Skipping Kalshi.`);
    teams.forEach((t, i) => {
        const key = normalizeName(t.team);
        const mp = manualMarket.get(`${key}|playoff`);
        if (mp !== undefined) {
            const edge = sim[i].playoffProbability - mp;
            playoffByTeam.set(key, {
                marketPrice: round(mp),
                marketProbability: round(mp),
                edge: round(edge),
                recommendation: edge >= Number(EDGE_THRESHOLD) ? 'VALUE' : 'WATCH',
                note: 'Manual override from marketProbabilities input. No de-vig, no fee model, no sizing.',
                marketSource: 'manual-input',
            });
        }
        const md = manualMarket.get(`${key}|division`);
        if (md !== undefined) {
            divisionByTeam.set(key, { marketProbability: round(md), edge: round(sim[i].divisionProbability - md), marketSource: 'manual-input' });
        }
    });
    marketMeta = { status: 'manual_override', marketSource: 'manual-input', matched: playoffByTeam.size, retrievedAt: marketRetrievedAt };
} else {
    const playoffEvent = KALSHI_PLAYOFF_EVENT(SEASON);
    try {
        const outcomes = await fetchKalshiEvent(playoffEvent);
        if (!outcomes.length) {
            log.warning(`Kalshi returned no open markets for ${playoffEvent}. Market fields stay null.`);
        } else {
            const projections = teams.map((t, i) => ({ team: t.team, probability: sim[i].playoffProbability }));
            const result = buildValueBets(projections, outcomes, {
                // Sixteen of the thirty-two clubs qualify, so these are independent
                // binaries and there is no overround to strip out. Normalising them
                // would divide every probability by sixteen.
                exclusive: false,
                targetSum: 16,
                maxSpread: 0.08,
                minEdge: Number(EDGE_THRESHOLD),
                bankroll: BANKROLL > 0 ? BANKROLL : 1000,
                maxPerPositionPct: MAX_PER_POSITION > 0 ? MAX_PER_POSITION : 0.02,
                maxTotalExposurePct: MAX_TOTAL_EXPOSURE > 0 ? MAX_TOTAL_EXPOSURE : 0.06,
            });
            marketMeta = result.meta ?? null;
            marketSourceLabel = marketMeta?.marketSource ?? 'kalshi';
            marketRetrievedAt = marketMeta?.retrievedAt ?? new Date().toISOString();
            for (const r of result.rows ?? []) playoffByTeam.set(normalizeName(r.team), r);
            log.info(`Kalshi ${playoffEvent}: ${marketMeta?.matched ?? 0} of ${teams.length} teams matched, field sum ${marketMeta?.fieldSum ?? 'n/a'} against an expected 16, integrity ${marketMeta?.fieldIntegrity ?? 'unknown'}.`);
            if (marketMeta?.fieldIntegrity === 'suspect') {
                log.warning(`Market field integrity is suspect: ${marketMeta.integrityNote ?? 'no note provided'} No row is reported as VALUE in this run.`);
            }
        }
    } catch (err) {
        log.warning(`Kalshi fetch failed, continuing without market data: ${err?.message ?? String(err)}`);
    }

    // Division winner markets. These are mutually exclusive races and, unlike the
    // playoff field, they are usually thin this early, so they are reported as a
    // probability and an edge only — no stake is ever sized off them.
    if (INCLUDE_DIVISION_MARKETS) {
        const eventsByDivision = KALSHI_DIVISION_EVENTS(SEASON);
        for (const [divisionName, eventTicker] of Object.entries(eventsByDivision)) {
            const members = teams.map((t, i) => ({ t, i })).filter(({ t }) => t.division === divisionName);
            if (!members.length) continue;
            try {
                const outcomes = await fetchKalshiEvent(eventTicker);
                if (!outcomes.length) {
                    log.warning(`Kalshi returned no open markets for ${eventTicker}.`);
                    continue;
                }
                const projections = members.map(({ t, i }) => ({ team: t.team, probability: sim[i].divisionProbability }));
                const result = buildValueBets(projections, outcomes, {
                    exclusive: true,
                    maxSpread: 0.08,
                    minEdge: Number(EDGE_THRESHOLD),
                    bankroll: BANKROLL > 0 ? BANKROLL : 1000,
                    maxPerPositionPct: MAX_PER_POSITION > 0 ? MAX_PER_POSITION : 0.02,
                    maxTotalExposurePct: MAX_TOTAL_EXPOSURE > 0 ? MAX_TOTAL_EXPOSURE : 0.06,
                });
                for (const r of result.rows ?? []) {
                    divisionByTeam.set(normalizeName(r.team), {
                        marketPrice: r.marketPrice,
                        marketProbability: r.marketProbability,
                        edge: r.edge,
                        recommendation: r.recommendation,
                        note: r.note,
                        marketTicker: r.marketTicker,
                        marketSpread: r.marketSpread,
                        marketSource: r.marketSource,
                    });
                }
                log.info(`Kalshi ${eventTicker}: ${result.meta?.matched ?? 0} of ${members.length} teams matched, field sum ${result.meta?.fieldSum ?? 'n/a'}, integrity ${result.meta?.fieldIntegrity ?? 'unknown'}.`);
            } catch (err) {
                log.warning(`Could not read ${eventTicker}: ${err?.message ?? String(err)}`);
            }
        }
        if (!marketSourceLabel && divisionByTeam.size) marketSourceLabel = 'kalshi';
        if (!marketRetrievedAt && divisionByTeam.size) marketRetrievedAt = new Date().toISOString();
    }
}

/* ── output ──────────────────────────────────────────────────────────────── */

const retrievedAt = marketRetrievedAt ?? new Date().toISOString();

/*
 * PRE-SEASON HONESTY GATE.
 *
 * Before a puck has been dropped this model knows exactly one thing: how each
 * club finished last season, shrunk towards .500. It does not know who was
 * traded, who got hurt, who signed in July or who changed coach. The market
 * knows all of it, so the biggest apparent "edges" in September are not edges —
 * they are the summer, and betting them is betting that the offseason did not
 * happen.
 *
 * So until the league has played enough games for the current season to carry
 * real information, no row is allowed to claim VALUE. The edge is still
 * reported, in full, and the row is marked WATCH so it can be tracked. Set
 * minGamesPlayedForValue to 0 to override this, deliberately.
 */
const leagueGamesPlayed = teams.length
    ? teams.reduce((s, t) => s + t.gamesPlayed, 0) / teams.length
    : 0;
const valueGateOpen = leagueGamesPlayed >= MIN_GAMES_FOR_VALUE;
if (!valueGateOpen) {
    log.warning(`The league averages ${leagueGamesPlayed.toFixed(1)} games played, below the ${MIN_GAMES_FOR_VALUE} needed for a VALUE call. Edges are reported but every row is downgraded to WATCH.`);
}

const results = teams.map((t, i) => {
    const s = sim[i];
    const key = normalizeName(t.team);
    const playoff = playoffByTeam.get(key) ?? null;
    const division = divisionByTeam.get(key) ?? null;

    let recommendation = playoff?.recommendation ?? 'NO_MARKET';
    let note = playoff?.note ?? 'No market data retrieved for this team.';
    let gated = false;
    if (!valueGateOpen && recommendation === 'VALUE') {
        recommendation = 'WATCH';
        gated = true;
        note = `Edge is real against the posted price, but the season has barely started (${leagueGamesPlayed.toFixed(0)} games played on average) and the model is still an extrapolation of last season. Tracked, not sized.`;
    }
    let divisionRecommendation = division?.recommendation ?? 'NO_MARKET';
    if (!valueGateOpen && divisionRecommendation === 'VALUE') divisionRecommendation = 'WATCH';

    return {
        season: SEASON,
        seasonLength,
        conference: t.conference,
        division: t.division,
        team: t.team,
        abbreviation: t.abbreviation,
        gamesPlayed: t.gamesPlayed,
        wins: t.wins,
        losses: t.losses,
        otLosses: t.otLosses,
        points: t.points,
        pointsPercentage: t.gamesPlayed ? round(t.points / (2 * t.gamesPlayed)) : null,
        gamesInProgress: gamesInProgress.get(t.id) ?? 0,
        gamesRemaining: t.gamesRemaining,
        goalsFor: t.goalsFor,
        goalsAgainst: t.goalsAgainst,
        goalDifferential: t.goalDifferential,
        actualWinPct: round(t.actualWinPct),
        pythagoreanWinPct: round(t.pythagoreanWinPct),
        trueTalentWinPct: round(t.trueTalentWinPct),
        projectedPoints: round(s.projectedPoints, 1),
        projectedWins: round(s.projectedWins, 1),
        projectedOvertimeLosses: round(s.projectedOvertimeLosses, 1),
        projectedRegulationLosses: round(Math.max(t.gamesPlayed + t.gamesRemaining - s.projectedWins - s.projectedOvertimeLosses, 0), 1),
        fairDivisionProbability: round(s.divisionProbability),
        fairWildCardProbability: round(s.wildCardProbability),
        fairPlayoffProbability: round(s.playoffProbability),
        fairTopSeedProbability: round(s.topSeedProbability),
        fairPresidentsTrophyProbability: round(s.presidentsTrophyProbability),

        marketPlayoffProbability: playoff?.marketProbability ?? null,
        marketPlayoffPrice: playoff?.marketPrice ?? null,
        playoffEdge: playoff?.edge ?? null,
        hasValue: recommendation === 'VALUE',
        estimatedFee: playoff?.estimatedFee ?? null,
        orderFee: playoff?.orderFee ?? null,
        netEV: playoff?.netEV ?? null,
        breakEvenProbability: playoff?.breakEvenProbability ?? null,
        suggestedContracts: gated ? 0 : playoff?.suggestedContracts ?? null,
        suggestedStake: gated ? 0 : playoff?.suggestedStake ?? null,
        suggestedFractionOfBankroll: gated ? 0 : playoff?.suggestedFractionOfBankroll ?? null,
        kellyFractionUncapped: playoff?.kellyFractionUncapped ?? null,
        positionCapBinding: playoff?.positionCapBinding ?? false,
        cappedByPortfolioLimit: gated ? false : playoff?.cappedByPortfolioLimit ?? false,
        recommendation,
        note,
        marketSpread: playoff?.marketSpread ?? null,
        marketTicker: playoff?.marketTicker ?? null,

        marketDivisionProbability: division?.marketProbability ?? null,
        marketDivisionPrice: division?.marketPrice ?? null,
        divisionEdge: division?.edge ?? null,
        divisionRecommendation,
        divisionMarketTicker: division?.marketTicker ?? null,

        marketSource: playoff?.marketSource ?? division?.marketSource ?? marketSourceLabel,
        preSeason,
        valueCallsEnabled: valueGateOpen,
        simulations: ITERATIONS,
        retrievedAt,
    };
}).sort((a, b) => b.fairPlayoffProbability - a.fairPlayoffProbability);

await Actor.pushData(results);

if (ARCHIVE_DATASET) {
    try {
        const history = await Actor.openDataset(ARCHIVE_DATASET);
        await history.pushData(results);
        log.info(`Appended ${results.length} rows to the named dataset "${ARCHIVE_DATASET}".`);
    } catch (err) {
        log.warning(`Could not append to the named dataset "${ARCHIVE_DATASET}": ${err.message}`);
    }
}

try {
    await Actor.charge({ eventName: 'team-projection', count: results.length });
} catch (err) {
    log.warning(`Could not charge for the results: ${err.message}`);
}

log.info(`Wrote ${results.length} team projections after ${ITERATIONS} simulated seasons.`);

await Actor.exit();
