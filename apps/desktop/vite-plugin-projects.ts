import { createReadStream, existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".jsonl": "text/plain; charset=utf-8",
};

/** Dev only: serves samples/<name>.marz/* at /projects/<name>/* with Range support. Only project.json is writable. */
export function projectsPlugin(samplesDir: string): Plugin {
  const root = resolve(samplesDir);
  return {
    name: "marz-projects",
    configureServer(server) {
      server.middlewares.use("/projects", async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const [, name, ...rest] = decodeURIComponent(url.pathname).split("/");
        const rel = rest.join("/");
        if (!name || !/^[\w.-]+$/.test(name) || name.includes("..") || rel.includes("..")) return next();
        const file = resolve(root, `${name}.marz`, rel);
        if (!file.startsWith(root + sep)) {
          res.statusCode = 403;
          return res.end();
        }

        if (req.method === "PUT") {
          if (rel !== "project.json") {
            res.statusCode = 403;
            return res.end("only project.json is writable");
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          await writeFile(file, Buffer.concat(chunks));
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
          createReadStream(file, { start, end }).pipe(res);
          return;
        }
        res.setHeader("Content-Length", size);
        if (req.method === "HEAD") return res.end();
        createReadStream(file).pipe(res);
      });
    },
  };
}
