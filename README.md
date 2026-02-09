# @violetrose/vite-plugin-dnn-ascx
Vite plugin to bundle assets into DotNetNuke (DNN) .ascx skin files and generate dev-ready skins.

```js
// vite.config.ts
import { defineConfig } from "vite";
import dnnAscx from "@violetrose/vite-dnn-ascx";

const skinPublicBase = `/Portals/_default/Skins/MySkin/`;

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : skinPublicBase,
  server: {
    cors: true, // needed for local DNN to include vite dev scripts from localhost
  },
  plugins: [
    dnnAscx({
      ascxGlobs: [`**/*.ascx`],
      publicBase: skinPublicBase,
    }),
  ],
}));
```

```html
<!-- home.ascx -->

<!-- @vite:entry src/home.js -->
<button id="counter" type="button">Counter: 0</button>
```

```js
// src/home.js
document.addEventListener("DOMContentLoaded", () => {
  let counter = 0;
  const counterButton = document.getElementById("counter");

  counterButton.on("click", () => {
    counter += 1;
    counterButton.textContent = `Counter: ${counter}`;
  })
});
```

## Basic Usage

### Development

For development, run `vite` and it should create a `.dnn` folder with your development skin.

Then, create a symlink in your DNN installation to this skin (the name can be anything as files are loaded from the vite dev server and not from the DNN Skin):

```
symlink /d "C:\<path-to-dnn>\Portals\_default\Skins\MySkinDev" "C:\<path-to-skin-project>\.dnn"
```

Lastly, add permissions to the `.dnn` folder for your IIS AppPool as you would for your DNN installation folder (i.e. `IIS AppPool\ApplicationName`, `Network Service`, `IUSR`).

### Production

Run `vite build` or `tsc && vite build` and the `dist` folder should contain your bundled skin. These files can be copied to your production DNN installation to deploy. The skin name and portal location should match what you pass for `publicBase`.

For local test builds, you can use the method described under [Development](#development) to create a symlink to the `dist` folder instead of `.dnn`, eliminating the need to copy/paste the output each time you rebuild.