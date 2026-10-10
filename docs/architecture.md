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

## Setup streaming and command aliases

Model setup uses `process.spawn({argv})` verified against the actual Claude Code
2.1.293 host: async chunks contain `{stream,text}`, and the terminal iterator
value contains `{code,signal}`. It reads bounded protocol-1 JSONL progress and
uses the same private heartbeat/cancel lease. Returning the iterator tears down
the stream; a late terminal event cannot start recording or change the selected
model. `process.run` remains the single-result recording path. Timers, commands,
UI buttons and prompt insertion are tested against that host. Native built-in `/voice` registration
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

## Managed package updates

The complete kit is copied and verified in a private per-user data directory.
Claude receives a local marketplace through its public CLI. Current Claude loads
local marketplace files in place, so an active runtime must not live directly
under a Brew Cellar/opt path that `brew upgrade` or cleanup can replace.
Package management and model setup use an exclusive lifecycle lock; capture
and inference hold shared locks. Setup stages and checks a new kit before replacement, restores the previous
kit on registration failure, and never writes Claude settings JSON itself.
Downloaded models stay outside either kit. Foreign marketplace registrations or
non-user scopes require explicit manual channel selection instead of silent migration.
