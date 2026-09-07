/*
 * model.js — the pure model. No network, no Actor SDK, so every function here
 * can be exercised directly by test/model.test.js.
 *
 * Three things make hockey different from the NFL and MLB versions of this
 * model and they are the whole reason this is a separate Actor:
 *
 * 1. STANDINGS RUN ON POINTS, NOT WINS. A regulation or overtime win is worth
 *    two points; losing in overtime or a shootout is still worth one. Ranking
 *    simulated seasons by wins would misprice every team that lives in
 *    one-goal games.
 * 2. THE PLAYOFF FIELD IS NOT "TOP 8 BY RECORD". Each conference sends the top
 *    three of each of its two divisions, then the two best teams left in the
 *    conference regardless of division. A fourth-place team in a strong
 *    division and a third-place team in a weak one are not interchangeable.
 * 3. EVERY GAME HAS A WINNER. There are no ties, so wins divided by games
 *    played averages exactly .500 across the league. That is what the strength
 *    estimate is built on — points percentage averages about .557 because of
 *    the loser point, and mixing it with a Pythagorean number centred on .500
 *    would bias every team upward.
 */

const PYTHAGOREAN_EXPONENT = 2.0; // Cole–Morrison exponent for goals in hockey.
// Season length is READ FROM THE SCHEDULE, never assumed: the 2025-26 season was
// 82 games and the 2026-27 season is 84 under the CBA signed in 2025. This is only
// the floor used when the schedule feed comes back short.
const MIN_SEASON_GAMES = 82;
const DIVISION_QUALIFIERS = 3; // top three of each division go straight through
const WILD_CARDS_PER_CONFERENCE = 2;

/* ── small helpers ───────────────────────────────────────────────────────── */

function logistic(x) {
    return 1 / (1 + Math.exp(-x));
}

// Box–Muller. One draw per team per simulated season, so the output carries the
// uncertainty in the strength estimate and not just schedule luck.
function gaussian() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

function normalizeName(name) {
    return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The NHL season is named by the year it ends: 2026-27 is season 2027 at ESPN.
 * Deriving it from the calendar year alone breaks every autumn, so anything
 * from July onwards belongs to next year's season.
 */
function defaultSeason(now = new Date()) {
    const y = now.getUTCFullYear();
    return now.getUTCMonth() >= 6 ? y + 1 : y;
}

/* ── model ───────────────────────────────────────────────────────────────── */

function buildRatings(teams, opts) {
    const { pythagoreanWeight, regressionGames } = opts;
    for (const t of teams) {
        const played = t.gamesPlayed;

        // Every NHL game has exactly one winner, so this averages .500 league-wide
        // and sits on the same scale as the Pythagorean estimate below.
        const actual = played ? t.wins / played : 0.5;

        const gf = t.goalsFor;
        const ga = t.goalsAgainst;
        const pythag = gf + ga > 0
            ? gf ** PYTHAGOREAN_EXPONENT / (gf ** PYTHAGOREAN_EXPONENT + ga ** PYTHAGOREAN_EXPONENT)
            : 0.5;

        const blended = pythagoreanWeight * pythag + (1 - pythagoreanWeight) * actual;
        const regressed = (blended * played + (t.priorTalent ?? 0.5) * regressionGames) / (played + regressionGames || 1);
        const clamped = Math.min(0.95, Math.max(0.05, regressed));

        t.actualWinPct = actual;
        t.pythagoreanWinPct = pythag;
        t.trueTalentWinPct = clamped;
        t.rating = Math.log(clamped / (1 - clamped));
    }
    return teams;
}

/**
 * One simulated season per iteration. Each remaining game is played out, points
 * are awarded the way the league awards them, and the real qualification rule
 * is applied: three per division plus two wild cards per conference.
 */
function simulate(teams, games, iterations, opts) {
    const { homeIceAdvantage, strengthUncertainty, overtimeProbability, overtimeDamping } = opts;
    const n = teams.length;
    const index = new Map(teams.map((t, i) => [t.id, i]));

    const baseRating = Float64Array.from(teams.map((t) => t.rating));
    const basePoints = Float64Array.from(teams.map((t) => t.points));
    const baseWins = Float64Array.from(teams.map((t) => t.wins));
    const baseOtl = Float64Array.from(teams.map((t) => t.otLosses));

    const gameHome = games.map((g) => index.get(g.homeId));
    const gameAway = games.map((g) => index.get(g.awayId));

    // conference -> division -> member indices
    const conferences = new Map();
    teams.forEach((t, i) => {
        if (!conferences.has(t.conference)) conferences.set(t.conference, new Map());
        const divs = conferences.get(t.conference);
        if (!divs.has(t.division)) divs.set(t.division, []);
        divs.get(t.division).push(i);
    });
    const conferenceList = [...conferences.values()].map((divs) => [...divs.values()]);

    const pointsSum = new Float64Array(n);
    const winsSum = new Float64Array(n);
    const otlSum = new Float64Array(n);
    const divisionTitles = new Float64Array(n);
    const wildCards = new Float64Array(n);
    const playoffs = new Float64Array(n);
    const topSeeds = new Float64Array(n);
    const presidents = new Float64Array(n);

    const rating = new Float64Array(n);
    const pts = new Float64Array(n);
    const wins = new Float64Array(n);
    const otl = new Float64Array(n);
    const noise = new Float64Array(n);

    // Points first, regulation-ish wins as the tiebreaker (the league uses
    // regulation wins), then a random draw so ties never resolve by array order.
    const score = (i) => pts[i] * 1000 + wins[i] + noise[i];

    for (let iter = 0; iter < iterations; iter += 1) {
        for (let i = 0; i < n; i += 1) {
            rating[i] = baseRating[i] + gaussian() * strengthUncertainty;
            pts[i] = basePoints[i];
            wins[i] = baseWins[i];
            otl[i] = baseOtl[i];
            noise[i] = Math.random();
        }

        for (let g = 0; g < gameHome.length; g += 1) {
            const h = gameHome[g];
            const a = gameAway[g];
            const gap = rating[h] - rating[a] + homeIceAdvantage;

            if (Math.random() < overtimeProbability) {
                // Three-on-three overtime and the shootout are far closer to a coin
                // flip than sixty minutes are, so the strength gap is damped here.
                if (Math.random() < logistic(gap * overtimeDamping)) {
                    pts[h] += 2; wins[h] += 1; pts[a] += 1; otl[a] += 1;
                } else {
                    pts[a] += 2; wins[a] += 1; pts[h] += 1; otl[h] += 1;
                }
            } else if (Math.random() < logistic(gap)) {
                pts[h] += 2; wins[h] += 1;
            } else {
                pts[a] += 2; wins[a] += 1;
            }
        }

        let leagueBest = -1;
        for (const divisions of conferenceList) {
            const pool = [];
            let conferenceBest = -1;

            for (const members of divisions) {
                const sorted = [...members].sort((x, y) => score(y) - score(x));
                for (let k = 0; k < DIVISION_QUALIFIERS && k < sorted.length; k += 1) playoffs[sorted[k]] += 1;
                divisionTitles[sorted[0]] += 1;
                pool.push(...sorted.slice(DIVISION_QUALIFIERS));
                if (conferenceBest < 0 || score(sorted[0]) > score(conferenceBest)) conferenceBest = sorted[0];
            }

            pool.sort((x, y) => score(y) - score(x));
            for (let k = 0; k < WILD_CARDS_PER_CONFERENCE && k < pool.length; k += 1) {
                playoffs[pool[k]] += 1;
                wildCards[pool[k]] += 1;
            }

            if (conferenceBest >= 0) {
                topSeeds[conferenceBest] += 1;
                if (leagueBest < 0 || score(conferenceBest) > score(leagueBest)) leagueBest = conferenceBest;
            }
        }
        if (leagueBest >= 0) presidents[leagueBest] += 1;

        for (let i = 0; i < n; i += 1) {
            pointsSum[i] += pts[i];
            winsSum[i] += wins[i];
            otlSum[i] += otl[i];
        }
    }

    return teams.map((t, i) => ({
        projectedPoints: pointsSum[i] / iterations,
        projectedWins: winsSum[i] / iterations,
        projectedOvertimeLosses: otlSum[i] / iterations,
        divisionProbability: divisionTitles[i] / iterations,
        wildCardProbability: wildCards[i] / iterations,
        playoffProbability: playoffs[i] / iterations,
        topSeedProbability: topSeeds[i] / iterations,
        presidentsTrophyProbability: presidents[i] / iterations,
    }));
}

export {
    PYTHAGOREAN_EXPONENT,
    MIN_SEASON_GAMES,
    DIVISION_QUALIFIERS,
    WILD_CARDS_PER_CONFERENCE,
    logistic,
    gaussian,
    round,
    normalizeName,
    defaultSeason,
    buildRatings,
    simulate,
};
