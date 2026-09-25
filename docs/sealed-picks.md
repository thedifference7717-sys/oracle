# Sealed picks

Paid picks can't be readable in a public repo before their games. But the
record is only worth something because every pick is committed *before* first
pitch. Sealing keeps both.

## How it works

- **At lock**, each Ladder pick, and each Dub and Robin leg, is committed
  **sealed**: encrypted with a secret key, next to a SHA-256 **fingerprint** of
  it. The stake, rung, ticket counts and publish time stay public. The player,
  market, price and teams do not.
- **When that leg's game starts**, the alerter publishes it in the clear with
  the salt it was fingerprinted with. Each leg reveals on its own clock, so a
  late game's leg is never given away by an early one. A Dub's price and the
  Ladder pick it leaves out stay sealed until everything they'd give away has
  started.
- **Anyone can check** that the revealed pick is the one committed before the
  game. No key is needed:

  ```sh
  git clone https://github.com/thedifference7717-sys/oracle && cd oracle
  node scripts/verify-seals.mjs
  ```

  For every revealed pick, it recomputes the fingerprint and finds the first
  commit that carried it sealed. That commit has to predate the game.

Telegram alerts are unchanged: subscribers still get the full pick at lock.
The code is in `scripts/seal.mjs`, with tests in `scripts/seal.test.mjs`.

## Turning it on

Sealing is **off until the key exists**. With no key, everything is published
exactly as before.

1. Generate a key: `openssl rand -base64 32`
2. Add it as a repository secret named **`PICKS_KEY`** (Settings → Secrets and
   variables → Actions → New repository secret).
3. Save a copy somewhere safe, such as a password manager. **A sealed pick can
   only be opened with the key it was sealed with.** Lose the key before a
   reveal and that pick can't be revealed or graded from the repo.

Picks placed after that are sealed. Picks already published stay as they were.

The same key also encrypts the alerter's own state (`state.json` in the Actions
cache), which holds the day's picks before they're revealed. If the key is ever
missing while that state is encrypted, the alerter stops with an error rather
than start from nothing and re-send alerts.

## Seeing sealed picks on the site yourself

Open any page once with the key in the link:

```
https://thedifference7717-sys.github.io/oracle/#key=<PICKS_KEY>
```

The key is stored in that browser only and removed from the address bar.
Sealed picks then show in full on that device. Open `#key=` (empty) to forget
it. Don't share this link: anyone holding the key can read every sealed pick.

## Not covered yet

- **The model is public.** `dd-model.js` and the dashboard's live board are in
  this repo, so someone determined can recompute similar candidates. Moving the
  model private is the job of `scripts/split-repos.sh`.
- **`data/ledger.json`** (the per-game doubles, which only calibrate the model)
  is not sealed.
- **Per-tier access on the site** isn't built yet. Delivery by tier is the
  Telegram channels step.
