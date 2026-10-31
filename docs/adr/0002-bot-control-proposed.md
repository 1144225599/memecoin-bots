# ADR-2: risk, exits and local bot controls (proposed)

Status: **Proposed**, not accepted.

Authoritative proposal: [ProjectBrain ADR-2](https://projectbrain.onrender.com/projects/01M6939CB70ZX4PHQ6QQSFZ8H4/plan/rules/01M69XBB91T3BR535TT4BBBZVE).

BOT-15 supplies a reviewable local implementation within ADR-1's existing
React/Vite, Fastify and PostgreSQL architecture. It adds public offline-wallet
preparation receipts, atomic wallet claims, bot configuration revisions, local
browser-session/CSRF protection and paper/off controls. It does not enable live
execution or accept signing material in the API/browser. See [bot controls](../bot-control.md).
