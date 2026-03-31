# Chili3D

Browser-based 3D CAD application. TypeScript monorepo with C++/WASM (OpenCascade) backend and Three.js rendering.

## Prerequisites

- Node.js >= 24.14.1

## Quick Reference

```bash
npm run dev          # Dev server (port 8080)
npm run build        # Production build
npm run test         # Run all tests (Rstest + Happy-DOM)
npm run testc        # Tests with coverage
npm run check        # Biome lint + auto-fix (runs on pre-commit)
npm run format       # Format all code (Biome + clang-format)
npm run build:wasm   # Build C++ WASM module (CMake + Emscripten)
npm run build:types  # Generate .d.ts for npm packages
```

Run a single test: `npx rstest packages/core/test/foo.test.ts`

## Architecture

Monorepo with 10 packages under `packages/`:

- **core** - Interfaces, math, commands, serialization (no deps)
- **app** - Application layer, commands, services (depends on core)
- **wasm** - OpenCascade WASM wrapper (depends on core)
- **three** - Three.js integration (depends on core)
- **ui** - UI components (depends on core, element)
- **element** - DOM custom elements (depends on core)
- **i18n** - Internationalization (depends on core)
- **storage** - IndexedDB persistence (depends on core)
- **builder** - AppBuilder pattern (depends on app, core, three, ui, wasm, i18n)
- **web** - Entry point (depends on builder)

Plugins live in `plugins/`. C++ source in `cpp/`.

## Code Conventions

- **Formatting**: Biome - 4 spaces, 110 char width, double quotes, semicolons required
- **Interfaces**: `IName` prefix (e.g., `IApplication`, `IDocument`)
- **Classes**: PascalCase | **Functions/Vars**: camelCase | **Constants**: UPPER_SNAKE_CASE
- **Files**: kebab-case.ts
- **Imports**: Use `@chili3d/<package>` names, not relative paths across packages. Prefix type-only imports with `type`.
- **Error handling**: `Result<T>` pattern, async/await preferred
- **Decorators**: Legacy mode enabled (`@command()`, serialization decorators)
- **C++ style**: WebKit via clang-format, C++17

## File Headers

TypeScript (AGPL-3.0):
```typescript
// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.
```

C++ (LGPL-3.0):
```cpp
// Part of the Chili3d Project, under the LGPL-3.0 License.
// See LICENSE-chili-wasm.text file in the project root for full license information.
```

## Commit Style

Conventional commits with emoji prefix, scoped by package:
```
feat(core): add observable collection
fix(three): resolve texture loading error
refactor(ui): extract button component
```

Pre-commit hooks run `biome check --write` (TS/JS/CSS/JSON) and `clang-format` (C++).
