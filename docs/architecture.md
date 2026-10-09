# Architecture

The Claude Mods module is small, dependency-free JavaScript. It can run in Claude's
sandbox without Node APIs. All host calls remain literal `$.namespace.method`
expressions so `claude plugin validate` can inspect them.

The native helper embeds `aximo-inference`, `aximo-core`, and `aximo-audio` from
Aximo commit `eca35cc89ad00953b3e5052a885a596a7c2a05b3`. CPAL owns native microphone
capture; Aximo owns audio normalization and local CPU inference. No HTTP listener,
localhost port, browser microphone, shell transcription pipeline, or cloud speech
service is started.

## Lifecycle

1. Preflight verifies the helper and downloaded model without capturing audio.
2. The mod schedules `process.run(record ...)` using the documented `clock.after`.
3. A separate heartbeat/control invocation returns loading/recording/transcribing
   status and conveys Stop/Cancel over a private session directory.
4. A hard native watchdog bounds recording and inference even if the mod reloads.
5. The helper returns one JSON result. A generation counter rejects stale results
   across cancellation and session changes.
6. `prompt.fill({text, mode: 'insert'})` returns `isFilled`; false keeps the pending
   text for a visible retry. The plugin never submits it.

The first version loads the speech model per dictation. This trades some startup
latency for isolated, bounded helper lifetimes and a documented stable Mods API.
Native incremental transcription and a persistent warm process are future work.

## Why no process.spawn or built-in voice replacement?

Current official reference lists `process.spawn`, but the public declaration copy
available during implementation predates it. We avoid inventing its stream/control
contract. `process.run`, timers, commands, UI buttons and prompt insertion are tested
against the real Claude Code 2.1.293 Mods host. Native built-in `/voice` registration
cannot be replaced by a plugin command. This plugin registers `/av`, `/avoice`,
and the original `/aximo-voice` separately because the tested `CommandSpec` has
no alias field. All three share one state machine, origin check, and dispatcher;
starting with one and stopping or cancelling with another controls the same
recording. A refused registration is never intercepted, and does not prevent
the remaining names from registering.

## Primary references

- [Mods API](https://code.claude.com/docs/en/plugins/mods/api)
- [Reference](https://code.claude.com/docs/en/plugins/mods/reference)
- [Types for your installed version](https://code.claude.com/docs/en/plugins/mods/create#get-type-definitions-for-your-version)
- [Real-host testing](https://code.claude.com/docs/en/plugins/mods/test)

Command registration reverified 2026-10-09. Tests and documentation name their actual host version rather
than assuming early-access APIs stay compatible across releases.
