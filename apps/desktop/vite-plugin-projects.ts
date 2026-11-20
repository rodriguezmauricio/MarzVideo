import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".jsonl": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Writable besides project.json: a background image the editor copied in (design 2026-11-19-background-image-blur). */
const ASSET_PUT = /^assets\/background-[0-9a-f]{8}\.(jpg|png)$/;
const MAX_ASSET_BYTES = 40 * 1024 * 1024;

/** Dev only: serves samples/<name>.marz/* at /projects/<name>/* with Range support. Only project.json and a
 *  background image under assets/ are writable. */
export function projectsPlugin(samplesDir: string): Plugin {
  return {
    name: "marz-projects",
    configureServer(server) {
      server.middlewares.use("/projects", projectsHandler(samplesDir));
    },
  };
}

/** The /projects middleware. A failure answers 500 (and logs) instead of leaving the request hanging;
 *  project.json is written to a temp file and renamed, like the app's storage. */
export function projectsHandler(samplesDir: string) {
  const root = resolve(samplesDir);
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    try {
      await handle(req, res, next);
    } catch (e) {
      console.error("[marz-projects]", req.method, req.url, e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const [, name, ...rest] = decodeURIComponent(url.pathname).split("/");
    const rel = rest.join("/");
    if (!name || !/^[\w.-]+$/.test(name) || name.includes("..") || rel.includes("..")) return next();
    const file = resolve(root, `${name}.marz`, rel);
    if (!file.startsWith(root + sep)) {
      res.statusCode = 403;
      return res.end();
    }

    if (req.method === "PUT" && ASSET_PUT.test(rel)) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_ASSET_BYTES) {
          res.statusCode = 413;
          return res.end();
        }
        chunks.push(c as Buffer);
      }
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(`${file}.tmp`, Buffer.concat(chunks));
      await rename(`${file}.tmp`, file);
      res.statusCode = 204;
      return res.end();
    }

    if (req.method === "PUT") {
      if (rel !== "project.json") {
        res.statusCode = 403;
        return res.end("only project.json is writable");
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      await writeFile(`${file}.tmp`, Buffer.concat(chunks));
      await rename(`${file}.tmp`, file);
      res.statusCode = 204;
      return res.end();
    }

    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    const size = statSync(file).size;
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", end - start + 1);
      if (req.method === "HEAD") return res.end();
      stream(createReadStream(file, { start, end }), res);
      return;
    }
    res.setHeader("Content-Length", size);
    if (req.method === "HEAD") return res.end();
    stream(createReadStream(file), res);
  }
}

/** Pipe a file to the response; a read error ends the response instead of throwing later. */
function stream(src: ReturnType<typeof createReadStream>, res: ServerResponse) {
  src.on("error", (e) => {
    console.error("[marz-projects] read failed", e);
    res.destroy();
  });
  src.pipe(res);
}
