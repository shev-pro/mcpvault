import { describe, expect, test } from "vitest";
import { parseCliArgs } from "./cli.js";

/**
 * --max-upload-mb is a new CLI flag (design brief: .aicc/design/vault-upload.md,
 * invariant I5). parseCliArgs's current ParsedCliArgs shape has no
 * maxUploadMb field, so every positive assertion below is RED against
 * current code.
 */

describe("parseCliArgs --max-upload-mb", () => {
  test("is undefined when the flag is not given", () => {
    expect(parseCliArgs(["/path/to/vault"]).maxUploadMb).toBeUndefined();
  });

  test("space-separated form sets the value", () => {
    expect(parseCliArgs(["/vault", "--max-upload-mb", "5"]).maxUploadMb).toBe(5);
  });

  test("equals form sets the value", () => {
    expect(parseCliArgs(["/vault", "--max-upload-mb=5"]).maxUploadMb).toBe(5);
  });

  test("accepts a fractional value", () => {
    expect(parseCliArgs(["/vault", "--max-upload-mb", "2.5"]).maxUploadMb).toBe(2.5);
  });

  test("returns the full parsed shape alongside existing fields", () => {
    expect(parseCliArgs(["/vault", "--max-upload-mb", "5"])).toEqual({
      vaultPathArg: "/vault",
      readOnly: false,
      excludePaths: [],
      maxUploadMb: 5,
    });
  });

  test("existing flags are unaffected when --max-upload-mb is absent", () => {
    expect(parseCliArgs(["/path/to/vault", "--read-only"])).toEqual({
      vaultPathArg: "/path/to/vault",
      readOnly: true,
      excludePaths: [],
    });
  });

  test.each([
    ["zero", ["--max-upload-mb", "0"]],
    ["negative", ["--max-upload-mb", "-1"]],
    ["non-numeric", ["--max-upload-mb", "abc"]],
    ["missing value", ["--max-upload-mb"]],
    ["value looks like another flag", ["--max-upload-mb", "--read-only"]],
  ])("rejects %s", (_label, flagArgs) => {
    expect(() => parseCliArgs(["/vault", ...flagArgs])).toThrow();
  });
});
