import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { projectsHandler } from "./vite-plugin-projects";

/** A PUT request with `body`, and a response that records its status. */
function put(url: string, body: string) {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { url, method: "PUT", headers: {} });
  const res = { statusCode: 200, ended: false, setHeader() {}, end() { this.ended = true; } };
  return { req, res };
}

describe("dev projects middleware", () => {
  test("a PUT of project.json writes it with no temp file left behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "marz-dev-"));
    mkdirSync(join(root, "demo.marz"));
    const { req, res } = put("/demo/project.json", '{"a":1}');
    await projectsHandler(root)(req as never, res as never, () => {});
    expect(res.statusCode).toBe(204);
    expect(readFileSync(join(root, "demo.marz", "project.json"), "utf8")).toBe('{"a":1}');
    expect(readdirSync(join(root, "demo.marz"))).toEqual(["project.json"]);
  });

  test("a failed write answers 500 instead of crashing the request", async () => {
    const root = mkdtempSync(join(tmpdir(), "marz-dev-"));
    const { req, res } = put("/gone/project.json", "{}");
    await projectsHandler(root)(req as never, res as never, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.ended).toBe(true);
  });
});
