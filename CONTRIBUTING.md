# Contributing

Bug reports, ideas and pull requests are welcome.

## Running it from your checkout

```sh
claude --plugin-dir ./spotify
```

Then `/spotify setup <client-id>` and `/spotify login`, as in the README.

## Before you open a pull request

```sh
claude plugin validate spotify   # what the mod hooks and calls, and anything the engine would refuse
claude plugin test spotify       # the tests in spotify/tests
```

Both run in CI on every push, along with `npx tsx scripts/smoke.mts` on macOS and Linux, which runs the real keychain, login listener and album art commands there. Add a test for the behaviour you change; `spotify/tests/fake.ts` fakes the Spotify Web API, the store and the platform, so tests never touch a real account.

## Layout

- `spotify/hooks/register.tsx`: the hooks module. Everything that talks to the engine (`$`) lives here, because the engine follows `$` only within the file that registers the hooks.
- `spotify/hooks/lib.ts`, `media.ts`, `settings.ts`, `jpeg.ts`: pure helpers with no engine access, shared by the module and the tests.
- `spotify/types/index.d.ts`: the values the mod keeps in the session's state.

## Style

Match the code around you: short functions, comments that say why, user-facing text that is plain and specific.
