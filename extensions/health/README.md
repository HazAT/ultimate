Warns you in the status line when a model provider stops working on this machine. It tracks whether each model provider works on this machine, from every real response, and reports a failing one to the `setup` status-line item.

## What is stored

One file per machine, `~/.ultimate/health.json`, written by every Ultimate home of the user:

```json
{
  "providers": {
    "anthropic": {
      "lastOk": 0,
      "lastFail": 0,
      "error": "invalid_grant",
      "lastUsed": 0
    }
  }
}
```

Times are epoch milliseconds. `lastOk`, `lastFail` and `lastUsed` come from real calls; nothing pings a provider. Two more fields count failures: `lastAuth`, and `transient`, the newest three transient failure times. They decide the state and are not reported. Only failures newer than `lastOk` count, so writes arriving out of order from two homes still give the same state.

## When a provider is failing

Each failure is classified by its summary (`failureKind` in `store.ts`):

- **auth** (401, 403, `invalid_grant`, `authentication_error`, `revoked`, …) turns the provider `failing` at once: the login is broken.
- **capacity** (429, 529, `overloaded_error`, rate-limit and quota codes) never does: the provider is busy, not the login. It is kept as the last error only.
- **transient** (timeouts, network errors, any other failure) turns it `failing` at the third in a row with no success between, or at one 5 minutes or more after the first of the streak. Capacity failures neither count toward a streak nor stretch its window.
- **billing** (402: a credit or spending limit, such as OpenRouter's `in_flight_budget_exhausted`) counts like a transient failure, but the provider's `cause` is `billing`, so the setup popover asks for credits instead of a new login.

A success newer than the failures ends both. A streak failure older than a day stops counting when health is read (`STALE`), so a provider nobody calls any more stops warning; an auth failure keeps warning until a success or a login change. A failing provider carries its `cause`: `auth`, `billing` or `transient`. Otherwise a provider is `ok` once it has a `lastOk`, else `unknown`. Writes read, merge each timestamp by its maximum (the `error` stays with the newest `lastFail`), count the new failure and rename a temporary file into place; two homes writing at once lose at most one event. An error is stored only as a structured summary: the HTTP status (when the message starts with it or names it, `status 401`) and the words of a fixed list of provider error codes and network errors it contains (`invalid_grant`, `rate_limit_error`, `overloaded`, `ECONNREFUSED`, …, `KNOWN` in `store.ts`), or "request failed". Its free text never is, so no request or auth contents reach the file; add a code to `KNOWN` to keep it. Health stays on this machine.

## Login changes

A login says nothing about the one it replaced, so a change starts that provider over at `unknown` (`reset` in `store.ts` drops its entry). Ultimate's own login and logout (`extensions/models`) reset the provider when they finish. A login made outside Ultimate (`pi` /login) resets nothing, but its first successful call ends any earlier failure. Health covers only providers with a login here: `providers()` leaves out entries of providers without one, and a real call to such a provider records nothing, so a stale failure never warns.

A write that flips a provider's state (`ok`, `failing`, `unknown`) emits `health.changed` `{ provider, state, error? }`
(`Changed` in `refs.ts`) with the sanitised error, in a commit of its own right after the file write (a login change's
reset, in the reactor's commit); a write that keeps the state emits nothing.

Every machine keeps its own logins: never copy `auth.json` between machines. OAuth logins rotate their refresh token, so the first refresh on one machine revokes the other's copy with `invalid_grant`.

## Real usage

A `GenerationTask` `afterResponse` hook records every terminal provider message at no cost: `stopReason: 'error'` records a failure with `errorMessage`, `aborted` nothing, anything else a success. The write never blocks or fails the generation.

## Status line

In every home the `setup` status-line item lists a failing provider with its error (`providers()`).
