The adapters layer implements external integrations. It is the only layer touching filesystem, shell, or process APIs, and `index.ts` is the only place adapters are constructed.
