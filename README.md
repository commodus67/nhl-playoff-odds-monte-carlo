# NHL Playoff Odds API — Monte Carlo Simulator & Value Bets

Every remaining game of the NHL season, replayed twenty thousand times, for all
32 clubs. You get a projected points total, the probability each team wins its
division, takes a wild card, qualifies for the playoffs at all, and finishes
first overall — and the same probabilities priced against the live contracts on
Kalshi, so you can see where the model and the market disagree.

No API key. No scraping. No subscription. Standings and schedules come from
ESPN's public feeds; prices come from Kalshi's public exchange API.

**Keywords:** NHL, hockey, playoff odds, Monte Carlo simulation, Stanley Cup,
sports analytics, prediction markets, Kalshi, betting odds, expected value,
Kelly criterion, sports data API.

---

## Why hockey needs its own model

This is not the football or baseball simulator with the team names swapped.
Three things about the NHL break a generic model:

**Standings run on points, not wins.** A win is two points. Losing in overtime
or a shootout is still worth one. Roughly 23% of games go past regulation, so a
season hands out about 3,100 points across 1,344 games rather than a tidy
two-per-game. A simulator that ranks teams by wins misprices every club that
lives in one-goal games. This one awards points the way the league does.

**The playoff field is not "the top eight by record".** Each conference sends
the top three of each of its two divisions — six teams — and then the two best
teams left in the conference regardless of division. A fourth-place team in a
strong division and a third-place team in a weak one are not interchangeable,
and the wild card is exactly where that asymmetry shows up. The simulator
applies the real rule on every one of its twenty thousand seasons.

**Overtime is close to a coin flip.** Three-on-three and the shootout are not
sixty minutes of hockey. A stronger team carries much less of its edge into the
extra period, so the strength gap is damped there rather than applied in full.

**The season is not 82 games any more.** The CBA signed in 2025 moved the league
to 84 games from 2026-27. This Actor never hardcodes a season length: it counts
the games actually on the schedule feed, so it was already right on the first
day of the new format and will stay right through the next change.

## What comes back

One row per team, with these columns among others:

| Column | What it is |
| --- | --- |
| `projectedPoints` | Mean points total across all simulated seasons |
| `fairPlayoffProbability` | Probability of qualifying, under the real 3+2 rule |
| `fairDivisionProbability` | Probability of finishing first in the division |
| `fairWildCardProbability` | Probability of qualifying *as a wild card* |
| `fairTopSeedProbability` | Probability of the best record in the conference |
| `fairPresidentsTrophyProbability` | Probability of the best record in the league |
| `trueTalentWinPct` | Strength estimate after regression, on a .500 scale |
| `marketPlayoffProbability` | The live Kalshi price, de-vigged |
| `playoffEdge` | Model minus market, in probability points |
| `netEV` | Expected value per contract **after Kalshi's fee** |
| `recommendation` | VALUE, WATCH, PASS, NO_MARKET or NO_MODEL |
| `suggestedStake` | Quarter-Kelly, clipped by your position and portfolio caps |

The playoff probabilities across all 32 rows always sum to exactly 16, because
exactly sixteen teams qualify. That is a property of the simulation, not a
normalisation applied afterwards, and it is the quickest sanity check you can
run on the output.

## The market side, done properly

**Qualification is not a mutually exclusive race.** Sixteen of thirty-two teams
make it, so the prices across the field sum to about 16, not to 1. De-vigging
that field — dividing every price by the total, the way you would for a division
winner market — would divide every probability by sixteen and manufacture
enormous fake edges across the whole league. This Actor treats qualification as
independent binaries and leaves the mid prices alone, and treats the four
division winner races as exclusive fields with the overround stripped out. The
`fieldSum` in the log tells you which one it applied and whether the field came
back complete.

**Fees are charged where they actually bite.** Kalshi's fee peaks at mid price:
1.75 cents per contract at $0.50 against 0.63 cents at $0.90. So a
one-and-a-half point edge on a coin-flip contract is a *losing* position after
fees, while the same edge on a heavy favourite is comfortably profitable.
`netEV` and `breakEvenProbability` are computed net of that fee, per contract,
with the rounding applied per order rather than per contract.

**Thin markets are not tradable markets.** A positive edge on a contract with no
open interest and a nine-cent spread is not an opportunity, it is a quote. Those
rows come back as WATCH with the reason attached, never as VALUE.

## The pre-season gate — read this in September

Before the first puck drops, this model knows exactly one thing: how each club
finished last season, shrunk 40% towards average. It does not know who was
traded, who got hurt, who signed in July or who changed coach. The market knows
all of it.

So in September the biggest apparent "edges" are not edges. They are the
offseason. Betting them is betting that the summer did not happen.

Until the league has played `minGamesPlayedForValue` games per team (10 by
default), every edge is still reported in full, but no row is allowed to claim
VALUE — they come back as WATCH so you can track how they move. Set it to 0 to
override that, deliberately. Once real games are in the books the current-season
record takes over from the prior, gradually, at the rate set by
`regressionGames`.

## Building your own history

An Apify run's dataset is deleted after a few days. Put a name in
`archiveToNamedDataset` — for example `nhl-playoff-odds-history` — and every run
also appends its rows to a named dataset in your account, which Apify keeps
indefinitely. Schedule the Actor daily and by March you own something you cannot
buy or reconstruct: the full path of how each team's probability moved across
the season, alongside what the market was charging for it on the same day.

## Inputs worth knowing about

| Input | Default | Why you would change it |
| --- | --- | --- |
| `iterations` | 20000 | Plenty for stable numbers. Raise for smoother tails. |
| `season` | current | A season is named by the year it *ends*: 2026-27 is `2027`. |
| `regressionGames` | 25 | Lower to trust the current record more. |
| `pythagoreanWeight` | 0.6 | How much comes from goal differential vs the raw record. |
| `overtimeProbability` | 0.23 | Share of games going past regulation. |
| `overtimeDamping` | 0.5 | 0 makes overtime a coin flip, 1 treats it like regulation. |
| `priorCarryover` | 0.6 | How much of last season survives into the pre-season prior. |
| `minGamesPlayedForValue` | 10 | Games needed before a VALUE call is allowed. |
| `includeDivisionMarkets` | true | Also price the four division winner races. |
| `marketProbabilities` | empty | Supply your own prices and skip Kalshi entirely. |

## Data sources

- **ESPN** — standings and full schedules, public endpoints, no key.
- **Kalshi** — `KXNHLPLAYOFF` for qualification and `KXNHLATLANTIC`,
  `KXNHLMETROPOLITAN`, `KXNHLCENTRAL`, `KXNHLPACIFIC` for the division races.
  Public exchange API, no key, CFTC-regulated.

If Kalshi is unreachable the run still completes: the model columns are filled
and the market columns come back null with an explanatory note, rather than the
run failing.

## FAQ

### How are NHL playoff odds calculated?

The Actor replays every remaining regular-season game 20,000 times. Each game is decided by a strength estimate for both clubs — a Pythagorean win expectation on goals for and against (exponent 2.0), blended with the actual record and regressed toward a prior from last season — plus home ice. Overtime and shootouts are simulated separately, with the strength gap damped. After each simulated season the real NHL rules are applied, and a team's playoff probability is simply the share of those 20,000 seasons in which it qualified.

### How many teams make the NHL playoffs, and how does the wild card work?

Sixteen of 32. In each conference the top three teams in each of the two divisions qualify, and the two best remaining teams in the conference take the wild cards regardless of division. `fairWildCardProbability` is the chance of getting in *as a wild card*; `fairPlayoffProbability` is the chance of getting in at all.

### Why does the NHL season have 84 games now?

The collective bargaining agreement signed in 2025 expanded the regular season to 84 games starting in 2026-27. The Actor counts the games on ESPN's schedule feed instead of assuming a season length, so projected points are on the right scale.

### What are Presidents' Trophy odds?

The probability of finishing with the best regular-season record in the whole league. Across the 32 rows `fairPresidentsTrophyProbability` sums to 1, and `fairPlayoffProbability` sums to exactly 16.

### Can I compare NHL playoff odds with Kalshi prices?

Yes. Every run fetches the live `KXNHLPLAYOFF` contracts and, optionally, the four division-winner markets. Qualification is priced as sixteen independent yes/no contracts (the field sums to about 16, so it is not de-vigged), division races are treated as exclusive fields, and `netEV` is calculated after Kalshi's fee.

### Why does every row say WATCH before the season starts?

In September the model only knows how last season ended; it has not seen trades, signings, injuries or coaching changes. Until each team has played `minGamesPlayedForValue` games (10 by default) no row can be labelled VALUE. The disagreement with the market is still reported in full.

### How can I track how NHL playoff odds change during the season?

Set `archiveToNamedDataset` (for example `nhl-playoff-odds-history`) and schedule the Actor daily. Each run appends its 32 rows, with a timestamp and the market price of the day, to a named dataset that Apify keeps indefinitely.

### Do I need an API key?

Not for the data: ESPN and Kalshi are read through public endpoints. You only need an Apify account to run the Actor from the Console, the API, a schedule or an AI agent.

### Is this betting advice?

No. It is a statistical simulation and a market comparison for research and analysis.

## What this is not

It is a statistical model and a market comparison, not advice. It does not place
orders, it does not know about injuries, goaltending changes, trades or coaching
changes, and it will be wrong about individual teams. Its value is in being
transparent about *why* it disagrees with a price, and honest about when it has
no business disagreeing at all.
