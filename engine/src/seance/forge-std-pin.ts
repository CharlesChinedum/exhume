/**
 * Pinned forge-std wiring and séance campaign constants.
 *
 * `FORGE_STD_PIN` must equal the trimmed content of
 * `engine/test/docker/FORGE_STD_PIN` (the Docker image checks out this tag);
 * a test keeps the two in step.
 */

/** forge-std tag vendored in the séance worker image. */
export const FORGE_STD_PIN = "v1.9.4";

/** Default `<FORGE_STD_DIR>`: where the Docker image holds the checkout. */
export const FORGE_STD_DEFAULT_DIR = "/opt/forge-std";

/** Invariant campaign runs written to `foundry.toml` (`report.runs`). */
export const INVARIANT_RUNS = 256;

/** Invariant campaign depth written to `foundry.toml` (`report.depth`). */
export const INVARIANT_DEPTH = 64;

/** Exact solc version of the port, forge-std and the generated tests. */
export const PORT_SOLC_VERSION = "0.8.28";

const FORBIDDEN_DIR_CHARS = /["\\\u0000-\u001f\u007f*?[\]{}]/;

/** Throws unless `dir` is an absolute path with no trailing slash and no TOML/glob-special characters. */
export function assertForgeStdDir(dir: string): void {
  if (
    typeof dir !== "string" ||
    !dir.startsWith("/") ||
    dir.length < 2 ||
    dir.endsWith("/") ||
    FORBIDDEN_DIR_CHARS.test(dir)
  ) {
    throw new Error(
      `forgeStdDir must be an absolute path without trailing slash, quotes, backslashes, control characters or glob characters: ${JSON.stringify(dir)}`,
    );
  }
}

/** Exact content of `remappings.txt` (trailing newline). */
export function remappingsText(forgeStdDir: string = FORGE_STD_DEFAULT_DIR): string {
  assertForgeStdDir(forgeStdDir);
  return `forge-std/=${forgeStdDir}/src/\n`;
}

/** The `allow_paths` line of `foundry.toml` (no trailing newline). */
export function allowPathsToml(forgeStdDir: string = FORGE_STD_DEFAULT_DIR): string {
  assertForgeStdDir(forgeStdDir);
  return `allow_paths = ["${forgeStdDir}"]`;
}
