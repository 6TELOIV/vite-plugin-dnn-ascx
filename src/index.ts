import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import type { OutputBundle, OutputChunk } from "rollup";
import fg from "fast-glob";

type EntryRef = {
  ascxPath: string; // absolute path to ascx
  entryAbs: string; // absolute path to entry module
};

/**
 * Context object passed to the `render` callback.
 *
 * This describes **one injected entry point** (one `@vite:entry` marker)
 * and provides both the original input information and the final resolved
 * URLs produced by Vite.
 *
 * The same renderer is used for both dev and build modes; branch on `mode`
 * if different markup is required.
 */
export type DnnAscxRenderContext = {
  /**
   * Indicates whether the plugin is running in dev (`vite serve`)
   * or production build (`vite build`) mode.
   */
  mode: "dev" | "build";

  /**
   * Absolute path to the `.ascx` file currently being rewritten.
   *
   * Useful when a renderer needs to vary output based on the specific
   * skin file (for example, injecting assets only into certain controls).
   */
  ascxPath: string;

  /**
   * Raw value captured from the `@vite:entry` marker.
   *
   * Example:
   * ```html
   * <!-- @vite:entry src/app.ts -->
   * ```
   *
   * Will produce:
   * ```ts
   * entryFromMarker === "src/app.ts"
   * ```
   */
  entryFromMarker: string;

  /**
   * Absolute filesystem path to the resolved entry module.
   *
   * This can be useful for branching based on the entry location
   * or file extension.
   */
  entryAbs: string;

  /**
   * Final URL for the JavaScript entry point.
   *
   * - In dev mode: points at the Vite dev server (e.g. `http://localhost:5173/src/app.ts`)
   * - In build mode: points at the hashed output file under the configured `publicBase`
   */
  jsUrl: string;

  /**
   * Final URLs for any CSS files associated with this entry.
   *
   * - In build mode: contains zero or more hashed CSS asset URLs
   * - In dev mode: usually empty (Vite injects CSS via JS)
   */
  cssUrls: string[];

  /**
   * URL to the Vite HMR client.
   *
   * Only provided in dev mode, and only for the **first** injected entry
   * in a given `.ascx` file.
   *
   * Example:
   * ```ts
   * "http://localhost:5173/@vite/client"
   * ```
   */
  devClientUrl?: string;

  /**
   * Rollup chunk associated with this entry (build mode only).
   *
   * Exposed for advanced use cases such as:
   * - inspecting imported modules
   * - reading metadata from `viteMetadata`
   */
  chunk?: OutputChunk;
};

/**
 * Options for the `DnnAscxPlugin`.
 */
export type DnnAscxPluginOptions = {
  /**
   * Glob patterns used to locate `.ascx` files that belong to the skin.
   *
   * These files will be:
   * - scanned for `@vite:entry` markers
   * - copied to the output directory
   * - rewritten when markers are present
   *
   * Example:
   * ```ts
   * ascxGlobs: ["Skins/MySkin/**\/*.ascx"]
   * ```
   */
  ascxGlobs: string[];

  /**
   * Output directory for rewritten `.ascx` files in production builds.
   *
   * Defaults to Vite's `build.outDir`.
   *
   * Example:
   * ```ts
   * outAscxDir: "dist/Skins/MySkin"
   * ```
   */
  outAscxDir?: string;

  /**
   * Regular expression used to detect entry markers inside `.ascx` files.
   *
   * Defaults to:
   * ```regex
   * <!-- @vite:entry <path> -->
   * ```
   *
   * Override this if you need a custom marker format.
   */
  marker?: RegExp;

  /**
   * Public base URL for built assets, as served by DNN.
   *
   * This is typically the skin path under `/Portals/_default/Skins/...`
   * and is used to construct absolute URLs for injected assets.
   *
   * Example:
   * ```ts
   * publicBase: "/Portals/_default/Skins/MySkin/"
   * ```
   */
  publicBase?: string;

  /**
   * Output directory for rewritten `.ascx` files in dev mode.
   *
   * This directory is intended to be symlinked into DNN so that
   * dev builds are immediately usable.
   *
   * Example:
   * ```ts
   * devOutAscxDir: ".dnn/Skins/MySkin"
   * ```
   */
  devOutAscxDir?: string;

  /**
   * Explicit origin URL for the Vite dev server.
   *
   * If not provided, the plugin will infer it from the Vite server
   * configuration.
   *
   * Example:
   * ```ts
   * devOrigin: "http://localhost:5173"
   * ```
   */
  devOrigin?: string;

  /**
   * Root directory used when mirroring `.ascx` files into output directories.
   *
   * Paths under this directory will be preserved in the output structure.
   *
   * Defaults to `process.cwd()`.
   */
  ascxRootDir?: string;

  /**
   * If true, the build will fail when no `@vite:entry` markers
   * are found in any `.ascx` files.
   *
   * Defaults to `false`.
   */
  requireAtLeastOneEntry?: boolean;

  /**
   * Custom renderer for injected markup.
   *
   * This function is called once per `@vite:entry` marker and should return
   * the HTML/ASCX markup that replaces the marker.
   *
   * If not provided, the plugin injects standard `<script>` and `<link>` tags.
   *
   * Example: using DNN server-side includes
   *
   * ```ts
   * render: ({ mode, jsUrl, cssUrls, devClientUrl }) => {
   *   const tags: string[] = [];
   *
   *   if (mode === "dev" && devClientUrl) {
   *     tags.push(`<script type="module" src="${devClientUrl}"></script>`);
   *   }
   *
   *   for (const css of cssUrls) {
   *     tags.push(`<dnn:DnnCssInclude runat="server" FilePath="${css}" />`);
   *   }
   *
   *   tags.push(`<dnn:DnnJsInclude runat="server" FilePath="${jsUrl}" />`);
   *   return tags.join("\\n");
   * }
   * ```
   */
  render?: (ctx: DnnAscxRenderContext) => string;
};

/**
 * Vite plugin that enables modern JS/CSS bundling for DotNetNuke (DNN) skins.
 *
 * The plugin:
 * - Uses `.ascx` files as logical entry points via `@vite:entry` markers
 * - Injects dev-server scripts during `vite serve`
 * - Injects hashed, cache-friendly assets during `vite build`
 * - Copies all `.ascx` files into build/dev output directories so skins are
 *   immediately usable without runtime manifest parsing
 *
 * @example Basic usage
 * ```ts
 * import { defineConfig } from "vite";
 * import dnnAscx from "@violetrose/vite-dnn-ascx";
 *
 * const skinPublicBase = `/Portals/_default/Skins/MySkin/`;
 *
 * export default defineConfig(({ command }) => ({
 *   base: command === "serve" ? "/" : skinPublicBase,
 *   server: {
 *     cors: true, // needed for local DNN to include vite dev scripts from localhost
 *   },
 *   plugins: [
 *     dnnAscx({
 *       ascxGlobs: [`**\/*.ascx`],
 *       publicBase: skinPublicBase,
 *     }),
 *   ],
 * }));
 * ```
 */
export default function dnnAscx(opts: DnnAscxPluginOptions): Plugin {
  let config: ResolvedConfig;
  let buildOutDir: string;
  let devOutDir: string;
  let prodOutDir: string | undefined;

  const marker = opts.marker ?? /<!--\s*@vite:entry\s+([^\s]+)\s*-->/g;

  let allAscxFiles: string[] = [];
  const refs: EntryRef[] = [];

  const ascxRootDir = path.resolve(opts.ascxRootDir ?? process.cwd());

  function norm(p: string) {
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }

  function absPath(p: string) {
    return norm(path.isAbsolute(p) ? p : path.resolve(p))
  }

  function dirToIgnore(dir?: string) {
    if (!dir) return [];
    const d = norm(dir);
    return [d, `${d}/**`];
  }

  function uniq(arr: string[]) {
    return Array.from(new Set(arr));
  }

  let ignore: string[] = [];

  function getChunkBySourceEntry(
    bundle: OutputBundle,
    entryAbs: string
  ): OutputChunk | undefined {
    for (const item of Object.values(bundle)) {
      if (item.type === "chunk" && item.isEntry) {
        if (
          item.facadeModuleId &&
          path.resolve(item.facadeModuleId) === entryAbs
        ) {
          return item;
        }
      }
    }
    return undefined;
  }

  const toPublicUrl = (p: string) => {
    const base = (opts.publicBase ?? config.base ?? "/").replace(/\/?$/, "/");
    return base + p.replace(/^\//, "");
  };

  function computeDevOrigin(server: ViteDevServer): string {
    if (opts.devOrigin) return opts.devOrigin.replace(/\/$/, "");
    const origin = server.config.server.origin;
    if (origin) return origin.replace(/\/$/, "");
    const port = server.config.server.port ?? 5173;
    return `http://localhost:${port}`;
  }

  function writeMirrored(
    outDir: string,
    absFilePath: string,
    contents: string
  ) {
    const rel = path.relative(ascxRootDir, absFilePath);
    const safeRel = rel.startsWith("..") ? path.basename(absFilePath) : rel;
    const outPath = path.join(outDir, safeRel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, contents, "utf8");
  }

  const defaultRender = (ctx: DnnAscxRenderContext) => {
    const tags: string[] = [];
    if (ctx.mode === "dev" && ctx.devClientUrl) {
      tags.push(`<script type="module" src="${ctx.devClientUrl}"></script>`);
    }
    for (const css of ctx.cssUrls)
      tags.push(`<link rel="stylesheet" href="${css}">`);
    tags.push(`<script type="module" src="${ctx.jsUrl}"></script>`);
    return tags.join("\n");
  };

  const render = opts.render ?? defaultRender;

  function rewriteAscxForDev(
    original: string,
    ascxAbs: string,
    devOrigin: string
  ): string {
    marker.lastIndex = 0;
    if (!marker.test(original)) return original;
    marker.lastIndex = 0;

    let injectedClient = false;
    const devClientUrl = `${devOrigin}/@vite/client`;

    return original.replace(marker, (_all, entryFromMarker: string) => {
      const entry = entryFromMarker.replace(/^\//, "");
      const jsUrl = `${devOrigin}/${entry}`;
      const entryAbs = path.resolve(entryFromMarker);

      const html = render({
        mode: "dev",
        ascxPath: ascxAbs,
        entryFromMarker,
        entryAbs,
        jsUrl,
        cssUrls: [],
        devClientUrl: injectedClient ? undefined : devClientUrl,
      });

      injectedClient = true;
      return html;
    });
  }

  function writeAllDevAscx(server: ViteDevServer) {
    const devOutAbs = path.resolve(opts.devOutAscxDir ?? ".dnn");
    const devOrigin = computeDevOrigin(server);

    fs.mkdirSync(devOutAbs, { recursive: true });

    for (const ascxAbs of allAscxFiles) {
      const original = fs.readFileSync(ascxAbs, "utf8");
      const rewritten = rewriteAscxForDev(original, ascxAbs, devOrigin);
      writeMirrored(devOutAbs, ascxAbs, rewritten);
    }
  }

  return {
    name: "vite-plugin-dnn-ascx",
    enforce: "post",

    async config(userConfig, env) {
      buildOutDir = userConfig.build?.outDir ?? "dist";
      devOutDir = opts.devOutAscxDir ?? ".dnn";
      prodOutDir = opts.outAscxDir; // may be undefined; that's fine

      ignore = uniq([
        // Always ignore vite build output
        ...dirToIgnore(buildOutDir),

        // Ignore our dev output
        ...dirToIgnore(devOutDir),

        // Ignore our build output if explicitly different
        ...dirToIgnore(prodOutDir),

        // Optional: ignore common junk
        "**/node_modules/**",
        "**/.git/**",
      ]);

      // Always discover ascx files (dev needs them too)
      allAscxFiles = (
        await fg(opts.ascxGlobs, {
          absolute: true,
          ignore,
          dot: true,
          followSymbolicLinks: false,
        })
      ).map(norm);

      // Only set watcher ignore on serve
      if (env.command === "serve") {
        return {
          server: {
            watch: {
              ignored: ignore,
            },
          },
        };
      }

      // Only compute Rollup inputs for build
      if (env.command === "build") {
        const inputs: Record<string, string> = {};
        refs.length = 0;

        for (const fAbs of allAscxFiles) {
          const content = fs.readFileSync(fAbs, "utf8");
          marker.lastIndex = 0;

          let m: RegExpExecArray | null;
          while ((m = marker.exec(content))) {
            const entryAbs = path.resolve(m[1]);
            const key = path
              .relative(process.cwd(), entryAbs)
              .replace(/[^\w]/g, "_");
            inputs[key] = entryAbs;
            refs.push({ ascxPath: fAbs, entryAbs });
          }
        }

        if (opts.requireAtLeastOneEntry && Object.keys(inputs).length === 0) {
          throw new Error("No @vite:entry markers found in ascx files.");
        }

        if (Object.keys(inputs).length === 0) return;

        return {
          build: {
            rollupOptions: { input: inputs },
          },
        };
      }
    },

    configResolved(resolved) {
      config = resolved;
    },

    configureServer(server) {
      const reload = () => server.ws.send({ type: 'full-reload', path: '*' });

      writeAllDevAscx(server);

      const watcher = server.watcher;

      // watch all ascx files
      watcher.add("**/*.ascx");

      const onChange = (file: string) => {
        const abs = absPath(file.toLowerCase());
        const absPublicDir = `${absPath(config.publicDir.toLowerCase() ?? "public")}/`;
        // public folder is simply copied over
        if (abs.startsWith(absPublicDir)){
          const original = fs.readFileSync(abs, "utf8");
          const dirWithoutPublicDir = absPath(abs.replace(absPublicDir, ''));
          writeMirrored(absPath(devOutDir), dirWithoutPublicDir, original);
          reload();
        } else if (abs.endsWith(".ascx")) {
          // ignore changes to non-included files.
          if (!allAscxFiles.includes(abs)) return;

          const devOrigin = computeDevOrigin(server);

          const original = fs.readFileSync(abs, "utf8");
          const rewritten = rewriteAscxForDev(original, abs, devOrigin);
          writeMirrored(absPath(devOutDir), abs, rewritten);
          reload();
        }
      };

      watcher.on("change", onChange);

      watcher.on("add", (file) => {
        if (file.toLowerCase().endsWith(".ascx")) {
          allAscxFiles = fg
            .sync(opts.ascxGlobs, { absolute: true, ignore })
            .map(norm);
          writeAllDevAscx(server);
          reload();
        }
      });

      watcher.on("unlink", (file) => {
        if (file.toLowerCase().endsWith(".ascx")) {
          allAscxFiles = fg
            .sync(opts.ascxGlobs, { absolute: true, ignore })
            .map(norm);
          writeAllDevAscx(server);
          reload();
        }
      });
    },

    generateBundle(_, bundle) {
      if (config.command !== "build") return;

      const outDir = path.resolve(opts.outAscxDir ?? config.build.outDir);
      fs.mkdirSync(outDir, { recursive: true });

      for (const fAbs of allAscxFiles) {
        const original = fs.readFileSync(fAbs, "utf8");

        marker.lastIndex = 0;
        const hasMarker = marker.test(original);
        marker.lastIndex = 0;

        if (!hasMarker) {
          writeMirrored(outDir, fAbs, original);
          continue;
        }

        const rewritten = original.replace(
          marker,
          (_all, entryFromMarker: string) => {
            const entryAbs = path.resolve(entryFromMarker);
            const chunk = getChunkBySourceEntry(bundle, entryAbs);
            if (!chunk) return `<!-- vite:missing-entry ${entryFromMarker} -->`;

            const jsUrl = toPublicUrl(chunk.fileName);
            const cssUrls: string[] = [];

            const md = (chunk as any).viteMetadata;
            if (md?.importedCss) {
              for (const c of md.importedCss as Set<string>)
                cssUrls.push(toPublicUrl(c));
            }

            return render({
              mode: "build",
              ascxPath: fAbs,
              entryFromMarker,
              entryAbs,
              jsUrl,
              cssUrls,
              chunk,
            });
          }
        );

        writeMirrored(outDir, fAbs, rewritten);
      }
    },
  };
}
