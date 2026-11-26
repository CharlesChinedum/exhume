/**
 * Task 13.1 SMOKE (not the 13.2 acceptance): runs the real BEC entry through runSeance with native forge
 * and prints what happened. It only asserts that the run completes; a failure prints the SeanceError
 * and keeps the temp project directory for diagnosis.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listInstalledSolc } from "../../src/seance/bytecode.js";
import { loadGraveyardInput } from "../../src/seance/graveyard.js";
import { parseReport, validateReport } from "../../src/seance/report.js";
import { createProcessRunner, runSeance } from "../../src/seance/runner.js";
import { ENGINE, LOCAL_STD, skipReason } from "./template-project.js";

const GRAVEYARD = resolve(ENGINE, "../graveyard");

const solc = listInstalledSolc();
const skip = skipReason !== "" ? skipReason : !solc.includes("0.4.19") ? "solc 0.4.19 is not installed" : "";

describe.skipIf(skip !== "")(`BEC smoke with native forge${skip ? ` (skipped: ${skip})` : ""}`, () => {
  it(
    "runs the BEC entry end to end and reports what happened",
    async () => {
      const input = loadGraveyardInput(GRAVEYARD, "bec");
      if (!input.ok) throw new Error(`${input.error.code}: ${input.error.message}`);
      const tmp = mkdtempSync(join(tmpdir(), "exhume-bec-smoke-"));
      const grave = join(tmp, "grave");
      mkdirSync(grave);
      const t0 = Date.now();
      const r = await runSeance(input.value, {
        runner: createProcessRunner(),
        now: Date.now,
        tmpRoot: tmp,
        forgeStdDir: LOCAL_STD,
        graveyardRoot: grave,
        graveyardName: "bec",
        keepTempOnFailure: true,
        keepTempOnSuccess: true,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.log(`[13.1 smoke] FAILED after ${ms} ms (temp kept in ${tmp}):\n${JSON.stringify(r.error, null, 2)}`);
        throw new Error(`${r.error.code}: ${r.error.message}`);
      }
      const rep = r.value.report;
      const written = r.value.reportPath !== undefined && existsSync(r.value.reportPath);
      const reparsed = written ? parseReport(readFileSync(r.value.reportPath!, "utf8")) : undefined;
      // eslint-disable-next-line no-console
      console.log(
        `[13.1 smoke] ok in ${ms} ms (temp kept in ${tmp})\n` +
          JSON.stringify(
            {
              totalCalls: rep.totalCalls,
              setupCalls: rep.setupCalls,
              counts: rep.counts,
              taintedCalls: rep.taintedCalls,
              exorcisms: rep.exorcisms.map((f) => ({ ...f, calldata: `${f.calldata.slice(0, 74)}... (${(f.calldata.length - 2) / 2} bytes)` })),
              portBugs: rep.portBugs,
              sequenceResults: { total: rep.sequenceResults.total, endedExorcised: rep.sequenceResults.endedExorcised, firstIndices: rep.sequenceResults.exorcisedAtIndex.slice(0, 5) },
              shrinking: rep.shrinking,
              skippedFunctions: rep.skippedFunctions,
              unreachableSites: rep.unreachableSites,
              reportPath: r.value.reportPath,
              reportValid: validateReport(rep).ok && reparsed?.ok === true,
            },
            null,
            2,
          ),
      );
      expect(validateReport(rep).ok).toBe(true);
      expect(written).toBe(true);
    },
    180_000,
  );
});
