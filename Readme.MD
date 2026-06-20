# Admin and supper admin..

Create admin account:
`npm run create:privileged-user -- --role admin --username admin2 --email admin2@wergame.com --password "StrongPass123"`

Create super admin account:
`npm run create:privileged-user -- --role superAdmin --username boss --email boss@wergame.com --password "StrongPass123"`

Update an admin/supper account
`npm run create:privileged-user -- --role admin --username admin2 --email admin2@wergame.com --password "NewStrongPass123" --update`


set a wallet address:
`npm run create:privileged-user -- --role superAdmin --username boss --email boss@wergame.com --password "StrongPass123" --walletAddress 0xabc... --update`

## Clear leaderboard & streaks

Leaderboard and streak pages are built from **Prediction** documents (won/lost + payout), not only `User.points` / `User.streak`. Use these scripts from the `backend` folder when you want to reset rankings for a new season or testing.

**Requires** `MONGODB_URI` in `backend/.env`. Always run `--dry-run` first.

### Clear leaderboard

Zeros all users' `points`, `correctPredictions`, `totalPredictions`, and `streak`. Resets resolved predictions (`won` / `lost` / `settled`) to `pending` with `payout: 0`.

```bash
# Preview (no writes)
npm run clear:leaderboard -- --dry-run
# or: node scripts/clearLeaderboard.js --dry-run

# Apply
npm run clear:leaderboard -- --yes

# Only free-prediction scores (free leaderboard filter)
node scripts/clearLeaderboard.js --yes --type free
```

`--type` options: `all` (default), `free`, `boost`, `market`.

### Clear streaks

Zeros `user.streak` for everyone and resets **free** predictions that are `won` / `lost` / `settled` back to `pending` so streak math starts at zero.

```bash
npm run clear:streaks -- --dry-run
npm run clear:streaks -- --yes
```

`--users-only` only clears `user.streak`; the streaks page may still show non-zero streaks until free prediction outcomes are reset. For points and full leaderboard reset, use `clearLeaderboard.js`.

