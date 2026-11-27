/**
 * Task 15.2: the planted-bug integration test inside the Docker image (Requirements 10.1, 10.2, 10.3).
 * Runs only when SEANCE_DOCKER=1 (set by engine/test/docker/run-planted.sh). Uses the product default
 * timeout (300 s). Reads graveyard/bec from <repo>/graveyard (mounted read-only in the container) and writes
 * only under a temp directory. Prints one `[15.2 planted] {json}` line per run.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPlantedBugAcceptance } from "../../src/seance/acceptance.js";
import { parseRecords } from "../../src/seance/report.js";
import { createProcessRunner } from "../../src/seance/runner.js";
import { plantAllowanceBug } from "./planted-bug.js";
import { ENGINE } from "./template-project.js";
const enabled = process.env.SEANCE_DOCKER === "1";
const GRAVEYARD = join(ENGINE, "../graveyard");
describe.skipIf(!enabled)("Planted_Port_Bug in Docker (SEANCE_DOCKER=1)", () => {
  it(
    "reports a shrunk, replay-confirmed transferFrom port-bug with at most 3 preceding calls",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "exhume-planted-docker-"));
      const t0 = Date.now();
      const r = await runPlantedBugAcceptance(
        {
          graveyardRoot: GRAVEYARD,
          outputRoot: root,
          runner: createProcessRunner(),
          now: Date.now,
          tmpRoot: root,
          forgeStdDir: process.env.SEANCE_FORGE_STD_DIR ?? "/opt/forge-std",
          keepTempOnSuccess: true,
        },
        { plant: plantAllowanceBug },
      );
      const ms = Date.now() - t0;
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.log(`[15.2 planted] ${JSON.stringify({ detected: false, ms, error: r.error })}`);
        throw new Error(`${r.error.code}: ${r.error.message}`);
      }
      const rep = r.value.report;
      const parsed = parseRecords(readFileSync(join(r.value.tempDir!, "seance-out/records.jsonl"), "utf8"), rep.runs);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const tf = parsed.value.records.filter((x) => x.function === "transferFrom" && x.classification === "port-bug");
      const finding = r.value.summary.finding;
      const out = {
        detected: true,
        ms,
        totalCalls: rep.totalCalls,
        counts: rep.counts,
        firstExorcismFuzzOrdinal: rep.firstExorcismFuzzOrdinal,
        firstTransferFromPortBugFuzzOrdinal: tf[0]?.fuzzOrdinal ?? null,
        transferFromPortBugRecords: tf.length,
        precedingCalls: finding.precedingCalls.map((c) => c.function),
        originalLength: (finding as { originalLength?: number }).originalLength,
        differingFields: finding.differingFields ?? [],
        shrinking: rep.shrinking,
      };
      // eslint-disable-next-line no-console
      console.log(`[15.2 planted] ${JSON.stringify(out)}`);
      expect(rep.counts["port-bug"]).toBeGreaterThanOrEqual(1);
      expect(finding.function).toBe("transferFrom");
      expect(finding.classification).toBe("port-bug");
      expect((finding as { unshrunk?: boolean }).unshrunk).not.toBe(true);
      expect(typeof (finding as { originalLength?: number }).originalLength).toBe("number");
      expect(finding.precedingCalls.length).toBeLessThanOrEqual(3);
      expect((finding.differingFields ?? []).some((f) => f.startsWith("state.allowance("))).toBe(true);
      expect(tf.length).toBeGreaterThan(0);
    },
    600_000,
  );
});
