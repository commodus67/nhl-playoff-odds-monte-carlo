import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    SEASON_GAMES,
    buildRatings,
    defaultSeason,
    logistic,
    simulate,
} from '../src/model.js';
import { devig, buildValueBets, matchOutcome, expectedValue } from '../src/marketOdds.js';

const DIVISIONS = [
    ['Eastern Conference', 'Atlantic Division'],
    ['Eastern Conference', 'Metropolitan Division'],
    ['Western Conference', 'Central Division'],
    ['Western Conference', 'Pacific Division'],
];

/** 32 clubs, 8 per division, with an optional strength ramp. */
function makeLeague({ ramp = 0 } = {}) {
    const teams = [];
    let n = 0;
    for (const [conference, division] of DIVISIONS) {
        for (let k = 0; k < 8; k += 1) {
            teams.push({
                id: String(n),
                team: `Team ${n}`,
                conference,
                division,
                wins: 0,
                losses: 0,
                otLosses: 0,
                points: 0,
                gamesPlayed: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                priorTalent: 0.5 + ramp * (16 - n) / 32,
            });
            n += 1;
        }
    }
    return teams;
}

/** A balanced double round robin inside each division, repeated to fill a season. */
function makeSchedule(teams, repeats = 6) {
    const games = [];
    for (let r = 0; r < repeats; r += 1) {
        for (let i = 0; i < teams.length; i += 1) {
            for (let j = i + 1; j < teams.length; j += 1) {
                if (teams[i].division !== teams[j].division) continue;
                games.push(r % 2 === 0
                    ? { homeId: teams[i].id, awayId: teams[j].id }
                    : { homeId: teams[j].id, awayId: teams[i].id });
            }
        }
    }
    return games;
}

const OPTS = { homeIceAdvantage: 0.12, strengthUncertainty: 0.1, overtimeProbability: 0.23, overtimeDamping: 0.5 };

describe('season year', () => {
    it('names a season by the year it ends', () => {
        assert.equal(defaultSeason(new Date('2026-09-07T12:00:00Z')), 2027);
        assert.equal(defaultSeason(new Date('2027-01-15T12:00:00Z')), 2027);
        assert.equal(defaultSeason(new Date('2027-04-01T12:00:00Z')), 2027);
        assert.equal(defaultSeason(new Date('2027-07-01T12:00:00Z')), 2028);
    });
});

describe('buildRatings', () => {
    it('falls back to the prior-season talent when no games have been played', () => {
        const teams = makeLeague({ ramp: 0.3 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        for (const t of teams) {
            assert.ok(Math.abs(t.trueTalentWinPct - t.priorTalent) < 1e-9,
                `${t.team}: ${t.trueTalentWinPct} vs prior ${t.priorTalent}`);
        }
    });

    it('does not leave all 32 teams identical before the season starts', () => {
        const teams = makeLeague({ ramp: 0.3 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const distinct = new Set(teams.map((t) => t.rating.toFixed(6)));
        assert.ok(distinct.size > 20, `only ${distinct.size} distinct ratings`);
    });

    it('reads strength from goals, not from the loser point', () => {
        const teams = makeLeague();
        teams[0].gamesPlayed = 82; teams[0].wins = 50; teams[0].losses = 32;
        teams[0].goalsFor = 300; teams[0].goalsAgainst = 200;
        teams[1].gamesPlayed = 82; teams[1].wins = 50; teams[1].losses = 32;
        teams[1].goalsFor = 220; teams[1].goalsAgainst = 240;
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        assert.ok(teams[0].trueTalentWinPct > teams[1].trueTalentWinPct,
            'the team with the better goal differential must rate higher on an identical record');
    });
});

describe('simulate', () => {
    it('awards exactly two points per regulation game and three per overtime game', () => {
        const teams = makeLeague();
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const games = makeSchedule(teams, 2);
        const sim = simulate(teams, games, 400, OPTS);
        const totalPoints = sim.reduce((s, r) => s + r.projectedPoints, 0);
        const expected = games.length * (2 + OPTS.overtimeProbability);
        assert.ok(Math.abs(totalPoints - expected) / expected < 0.02,
            `points ${totalPoints.toFixed(1)} vs expected ${expected.toFixed(1)}`);
    });

    it('every game produces exactly one winner', () => {
        const teams = makeLeague();
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const games = makeSchedule(teams, 2);
        const sim = simulate(teams, games, 300, OPTS);
        const totalWins = sim.reduce((s, r) => s + r.projectedWins, 0);
        assert.ok(Math.abs(totalWins - games.length) < 1e-6,
            `wins ${totalWins} vs games ${games.length}`);
    });

    it('sends exactly sixteen teams to the playoffs', () => {
        const teams = makeLeague({ ramp: 0.3 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const sim = simulate(teams, makeSchedule(teams, 2), 500, OPTS);
        const total = sim.reduce((s, r) => s + r.playoffProbability, 0);
        assert.ok(Math.abs(total - 16) < 1e-9, `playoff probabilities sum to ${total}`);
    });

    it('crowns exactly four division winners, four wild cards and one Presidents Trophy', () => {
        const teams = makeLeague({ ramp: 0.3 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const sim = simulate(teams, makeSchedule(teams, 2), 500, OPTS);
        const sum = (k) => sim.reduce((s, r) => s + r[k], 0);
        assert.ok(Math.abs(sum('divisionProbability') - 4) < 1e-9);
        assert.ok(Math.abs(sum('wildCardProbability') - 4) < 1e-9);
        assert.ok(Math.abs(sum('topSeedProbability') - 2) < 1e-9);
        assert.ok(Math.abs(sum('presidentsTrophyProbability') - 1) < 1e-9);
    });

    it('never counts a division winner as a wild card', () => {
        const teams = makeLeague({ ramp: 0.3 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const sim = simulate(teams, makeSchedule(teams, 2), 500, OPTS);
        for (const r of sim) {
            assert.ok(r.divisionProbability + r.wildCardProbability <= r.playoffProbability + 1e-9);
        }
    });

    it('lets a strong team in a strong division qualify through the wild card', () => {
        // Eight strong clubs stacked in one division: three take the division slots,
        // the rest have to come through the conference wild card or miss out.
        const teams = makeLeague();
        for (const t of teams) t.priorTalent = t.division === 'Atlantic Division' ? 0.62 : 0.48;
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const sim = simulate(teams, makeSchedule(teams, 4), 800, OPTS);
        const atlantic = teams.map((t, i) => ({ t, r: sim[i] })).filter(({ t }) => t.division === 'Atlantic Division');
        const wcShare = atlantic.reduce((s, { r }) => s + r.wildCardProbability, 0);
        assert.ok(wcShare > 0.5, `stacked division took only ${wcShare.toFixed(2)} wild card slots`);
    });

    it('gives a better team a higher playoff probability', () => {
        const teams = makeLeague({ ramp: 0.5 });
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const sim = simulate(teams, makeSchedule(teams, 4), 800, OPTS);
        const best = sim[0].playoffProbability;
        const worst = sim[31].playoffProbability;
        assert.ok(best > worst + 0.2, `best ${best} vs worst ${worst}`);
    });

    it('projects a full season of games for every club', () => {
        const teams = makeLeague();
        buildRatings(teams, { pythagoreanWeight: 0.6, regressionGames: 25 });
        const games = makeSchedule(teams, 6); // 8 teams x 7 opponents x 6 = 42 games each
        const sim = simulate(teams, games, 300, OPTS);
        for (const r of sim) {
            const played = r.projectedWins + r.projectedOvertimeLosses;
            assert.ok(played <= SEASON_GAMES, `${played} games projected, season is ${SEASON_GAMES}`);
        }
    });
});

describe('overtime damping', () => {
    it('pulls overtime results towards a coin flip', () => {
        const gap = 0.8;
        assert.ok(logistic(gap * 0.5) < logistic(gap));
        assert.ok(logistic(gap * 0.5) > 0.5);
    });
});

describe('market side', () => {
    const field = (prices) => prices.map((p, i) => ({
        source: 'kalshi', label: `Team ${i}`, ticker: `T${i}`, price: p,
        bid: p - 0.01, ask: p + 0.01, spread: 0.02, volume: 5000, openInterest: 5000, liquidity: 0,
    }));

    it('does not normalise the 16-of-32 qualification field', () => {
        const priced = devig(field(new Array(32).fill(0.5)), { exclusive: false, targetSum: 16 });
        assert.equal(priced[0].marketProbability, 0.5);
        assert.equal(priced[0].devigMethod, 'none (independent binaries)');
    });

    it('strips the overround from a division winner race', () => {
        const priced = devig(field([0.4, 0.3, 0.2, 0.2]), { exclusive: true });
        const total = priced.reduce((s, o) => s + o.marketProbability, 0);
        assert.ok(Math.abs(total - 1) < 1e-9, `de-vigged field sums to ${total}`);
    });

    it('refuses to call anything VALUE when the field is incomplete', () => {
        const projections = new Array(4).fill(0).map((_, i) => ({ team: `Team ${i}`, probability: 0.9 }));
        const { rows, meta } = buildValueBets(projections, field([0.2, 0.2, 0.1, 0.1]), { exclusive: false, targetSum: 16 });
        assert.equal(meta.fieldIntegrity, 'suspect');
        assert.equal(rows.filter((r) => r.recommendation === 'VALUE').length, 0);
    });

    it('kills a one-and-a-half point edge on a coin flip, and keeps it on a favourite', () => {
        // The fee peaks at mid price: 1.75 points at $0.50 against 0.63 at $0.90.
        // The same edge is therefore a loser on one contract and a winner on the other.
        const coinFlip = expectedValue(0.515, 0.5);
        assert.ok(coinFlip.grossEV > 0, 'gross edge is positive');
        assert.ok(coinFlip.netEV < 0, 'but it does not survive the fee at mid price');

        const favourite = expectedValue(0.915, 0.9);
        assert.ok(favourite.netEV > 0, 'the same edge survives on a heavy favourite');
    });

    it('matches NHL club names across both feeds', () => {
        const outcomes = field([0.5]).map((o) => ({ ...o, label: 'Montréal Canadiens' }));
        assert.ok(matchOutcome('Montreal Canadiens', outcomes));
        const utah = field([0.5]).map((o) => ({ ...o, label: 'Utah Mammoth' }));
        assert.ok(matchOutcome('Utah Mammoth', utah));
        const blues = field([0.5]).map((o) => ({ ...o, label: 'St. Louis Blues' }));
        assert.ok(matchOutcome('St. Louis Blues', blues));
    });

    it('never sizes two positions off one contract', () => {
        const outcomes = field([0.5]).map((o) => ({ ...o, label: 'Utah Mammoth' }));
        const { rows } = buildValueBets(
            [{ team: 'Utah Mammoth', probability: 0.9 }, { team: 'Utah Hockey Club', probability: 0.9 }],
            outcomes,
            { exclusive: false, targetSum: 1 },
        );
        assert.equal(rows.filter((r) => r.marketProbability !== null).length, 1);
        assert.ok(rows.some((r) => r.recommendation === 'DUPLICATE_MATCH'));
    });
});
