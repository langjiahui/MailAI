# Three.js 0.180.0

Local runtime for the author logo. Source: https://registry.npmjs.org/three/-/three-0.180.0.tgz

- `build/three.core.min.js` and `build/three.module.min.js` are unmodified.
- `examples/jsm/loaders/SVGLoader.js` changes only the bare `three` import to `./three.module.min.js`.
- The upstream MIT license is included in `LICENSE`.

These modules load on demand from the local app; the logo makes no CDN requests.
