# Benchmark: analyze on public API descriptions

undogen 0.1.0, 2026-11-19. Regenerate with `npx tsx scripts/benchmark.ts --out docs/benchmarks.md`.

| API | Operations | Writes | Reversible | Compensable | Irreversible (gated) | Unknown | Undo derived | Spec warnings | Time | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| GitHub REST | 1281 | 614 | 302 | 46 | 136 | 130 | 57% | 1 | 3.4s |  |
| Stripe | 612 | 339 | 105 | 27 | 101 | 106 | 39% | 1 | 2.5s | POST-for-update style |
| Twilio Api v2010 | 197 | 94 | 42 | 22 | 18 | 12 | 68% | 0 | 0.4s | form-encoded bodies |
| Asana | 271 | 143 | 49 | 18 | 7 | 69 | 47% | 0 | 0.7s |  |
| DigitalOcean | 916 | 448 | 190 | 71 | 80 | 107 | 58% | 6 | 9.1s | hundreds of external $ref files |
| Slack Web | 174 | 94 | 24 | 0 | 1 | 69 | 26% | 0 | 0.4s | Swagger 2.0, RPC style |
| Kubernetes | 1163 | 586 | 386 | 92 | 91 | 17 | 82% | 1 | 1.2s | Swagger 2.0 |

**Undo derived** is the share of write operations that get a compiled inverse with no hand-written code. 
These are hypotheses: only `undogen verify` against a sandbox shows whether an inverse works. 
The confidence scores in each plan are heuristic and not calibrated; calibrating them needs verify results across many APIs.
