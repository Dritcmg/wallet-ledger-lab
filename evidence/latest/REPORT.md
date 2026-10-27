# Reproducible verification

Status: **PASSED**. Generated: 2026-10-27T23:35:01.619Z.

Runtime: Bun 1.4.4; linux/x64.

Integration application entrypoint: dist/main.js.

Built artifact: `dist/main.js`; 110923 bytes; SHA-256 `f94645bf474edd961f244517712928183c93e161b80c67c6a2bb044e4ba1af3d`.

Source fingerprint (SHA-256): `7099868ee0f0fed85db59b1c91ec0b050f869c1f88e4c773737d1a044a149a67`.

The fingerprint covers executable source, tests, scripts, dependency lock and public configuration. Documentation and generated evidence are excluded to prevent a self-referencing fingerprint. The complete scope and per-file hashes are in source-manifest.json.

| Step | Command | Status | Exit | Duration ms |
| --- | --- | --- | --- | --- |
| typecheck | `bun run typecheck` | PASSED | 0 | 3236 |
| build | `bun run build` | PASSED | 0 | 55 |
| unit | `bun test ./tests/unit` | PASSED | 0 | 1356 |
| integration | `bun test --timeout 120000 --max-concurrency 1 ./tests/integration` | PASSED | 0 | 26163 |
| audit | `bun audit --json` | PASSED | 0 | 671 |
| publication | `bun scripts/publication-check.ts --json` | PASSED | 0 | 144 |
| gitleaks-version | `gitleaks version` | PASSED | 0 | 26 |
| gitleaks | `gitleaks dir public-stage --config .gitleaks.toml --redact --report-format json --report-path private-report.json` | PASSED | 0 | 368 |
| application-entrypoint | `validate integration application entrypoint` | PASSED | 0 | 0 |
| source-integrity | `source fingerprint comparison` | PASSED | 0 | 2 |
| curated-publication | `publication check of curated evidence` | PASSED | 0 | 123 |

| Suite | Passed | Failed | Skipped | Todo | Assertions | Parsed runner totals |
| --- | --- | --- | --- | --- | --- | --- |
| unit | 118 | 0 | 0 | 0 | 2415 | matched |
| integration | 47 | 0 | 0 | 0 | 239 | matched |

Dependency audit: 0 affected packages. Publication policy: PASSED.

Native secret scan: Gitleaks 8.30.1; PASSED; 0 findings.

JUnit contains case metadata only. Raw standard output and error streams remain in the ignored private artifacts directory and are never copied into this report or the distribution.

These results describe the local laboratory and the recorded source fingerprint. Synthetic telemetry is a demonstration, not a performance benchmark. Pattern-based privacy checks and dependency auditing complement review; neither is a universal security guarantee.
