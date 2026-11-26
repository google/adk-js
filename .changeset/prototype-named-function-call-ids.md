---
"@google/adk": patch
---

Tool confirmations, authentication requests, and artifact versions are no longer dropped when a model supplies a prototype-named key such as `__proto__` as the function call ID or artifact filename. `Context` now defines these entries as own properties, so the confirmation and credential events are emitted as usual.
