# Third-party notices and provenance

The implementation in `src/` is original code. No Remotely Save PRO code or tests are copied. The upstream checkout and research snapshots are excluded from builds. The project is Apache-2.0.

The only bundled dependency is `node-diff3@3.2.1`, MIT, from https://github.com/bhousel/node-diff3. It is used by the same merge algorithm inline and in the embedded browser Worker. Its license is retained in `licenses/node-diff3-MIT.md` and the generated `THIRD_PARTY_NOTICES.txt`.

The WebDAV SDK and its transitive runtime dependencies were removed at v0.2.0. Historical WebDAV license material belongs to earlier research and is not included in the v0.2.0 bundle. Obsidian remains external. TypeScript, esbuild, test libraries and Node/Python tools are development dependencies only. No Electron/Node package, native binary, Rust or WASM runtime is distributed. The desktop close guard uses the existing host bridge dynamically.

The build inventories both main and Worker inputs. Release verification checks the actual bundled license list, browser-only inputs, the single Obsidian external and artifact hashes. Linux/Android physical validation is still pending; see the platform matrix.
