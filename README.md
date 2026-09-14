# Pi Handoff

> Scaffold stage: the extension currently provides only its registration harness and `/handoff status` placeholder.

Pi Handoff will keep the current Pi session as the reviewer while a child Pi process implements an approved handoff, then reopen review gates for the result. The full design and T1–T12 rollout plan are documented in [`docs/design.md`](docs/design.md).

## Install

```text
pi install /absolute/path/to/pi-handoff
```

## Development

The scaffold registers `/handoff status`, which reports `Handoff: idle`.

Run the complete local check with:

```text
npm run check
```
