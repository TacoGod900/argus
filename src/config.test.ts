import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = `
repo: ./fixtures/demo-app
ref: bug/broken-login
base: main
install: npm ci
start: npm run start
baseUrl: http://localhost:3000
readyCheck:
  url: http://localhost:3000
`;

describe("parseConfig", () => {
  it("parses a valid config and applies readyCheck defaults", () => {
    const cfg = parseConfig(valid);
    expect(cfg.repo).toBe("./fixtures/demo-app");
    expect(cfg.ref).toBe("bug/broken-login");
    expect(cfg.base).toBe("main");
    expect(cfg.start).toBe("npm run start");
    expect(cfg.baseUrl).toBe("http://localhost:3000");
    // defaults
    expect(cfg.readyCheck.expectStatus).toBe(200);
    expect(cfg.readyCheck.timeoutMs).toBe(60_000);
    expect(cfg.readyCheck.intervalMs).toBe(1_000);
    expect(cfg.env).toEqual({});
  });

  it("allows omitting optional fields", () => {
    const cfg = parseConfig(`
repo: ./app
start: npm start
baseUrl: http://localhost:8080
readyCheck:
  url: http://localhost:8080/health
  expectStatus: 204
`);
    expect(cfg.ref).toBeUndefined();
    expect(cfg.install).toBeUndefined();
    expect(cfg.readyCheck.expectStatus).toBe(204);
  });

  it("rejects a config missing required fields", () => {
    expect(() => parseConfig(`repo: ./app`)).toThrow();
  });

  it("rejects a non-URL baseUrl", () => {
    expect(() =>
      parseConfig(`
repo: ./app
start: npm start
baseUrl: not-a-url
readyCheck:
  url: http://localhost:3000
`),
    ).toThrow();
  });
});
