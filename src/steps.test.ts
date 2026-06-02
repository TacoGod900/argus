import { describe, expect, it } from "vitest";
import { parseSteps } from "./steps.js";

describe("parseSteps", () => {
  it("keeps non-empty lines and drops blanks and comments", () => {
    const steps = parseSteps(
      ["# a flow", "", "Sign up with a fresh email", "  Log out  ", "# note", "Log back in"].join(
        "\n",
      ),
    );
    expect(steps).toEqual(["Sign up with a fresh email", "Log out", "Log back in"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseSteps("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});
