# Séance risk checks (task 1)

Each Known risk in the séance-engine design is checked by a script, run twice:
natively (local Foundry 1.5.1) and in the linux/amd64 Docker image.

## Layout

| Path | Purpose |
| --- | --- |
| `FORGE_STD_PIN` | forge-std tag used by both runs. |
| `Dockerfile` | linux/amd64 image: Foundry 1.5.1 (build fails otherwise), solc 0.4.19, solc 0.8.28, forge-std at `/opt/forge-std`. |
| `run-risks-native.sh` | Checks `forge --version` is 1.5.1, clones forge-std at the pin into `.cache/forge-std` (override with `FORGE_STD_DIR`), runs `risks/*.sh`. Records the path in `findings/native-env.txt`. |
| `run-risks.sh` | Builds the image, runs `risks/*.sh` inside it via `run-in-container.sh`. |
| `lib.sh`, `run-in-container.sh` | Shared harness code and the container entrypoint. |
| `fixtures/token/` | Minimal project: `src/legacy/LegacyToken.sol` (solc 0.4.19, unchecked `cnt * _value` in `batchTransfer`) and `src/port/PortToken.sol` (0.8 port). Both define `contract Token`. |
| `risks/` | One script per risk (tasks 1.2 to 1.9). |
| `findings/` | `<sub-task>.native.md` and `<sub-task>.docker.md`, written by the risk scripts. |

## Risk script contract

Each `risks/*.sh` runs with its working directory set to a fresh scratch copy
of `fixtures/token/` (with `remappings.txt` and `allow_paths` already pointing
at forge-std) and exits non-zero on failure. Environment variables:
`MODE` (`native` or `docker`), `RISK_NAME`, `FIXTURE_DIR`, `SCRATCH`,
`FORGE_STD_DIR`, and `FINDINGS_FILE` (the file to write).

### Native-only scripts

A script whose header (first 15 lines) contains the line
`# harness: native-only` is not executed in Docker mode. The loop in `lib.sh`
prints `SKIP (native-only): <script>` and does not count it as a failure, so
`run-risks.sh` exits 0 when every other script passes. As a fallback, a script
that exits 2 in Docker mode is also reported as skipped. In native mode these
scripts run normally and any non-zero exit (including 1.11's exit 1 on
non-determinism) still counts as a failure, as before. `risks/1.11-seed-determinism.sh`
carries the marker.

With no scripts in `risks/`, both harnesses print a notice and exit 0.

## Notes

- `compilation_restrictions` versions must be exact (`=0.4.19`). A bare
  `0.4.19` is read as `^0.4.19` and forge picks 0.4.26.
- Docker on Apple Silicon runs amd64 under emulation. Its timings are not representative.
