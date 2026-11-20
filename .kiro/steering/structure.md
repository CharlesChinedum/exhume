---
inclusion: always
---

# Repository structure

- `engine/`: fetcher, autopsy, codemod, séance generator, reports.
- `worker/`: HTTP service that runs séances.
- `web/`: web app.
- `graveyard/<name>/`: one directory per dead contract, holding its source, metadata, and precomputed report.
