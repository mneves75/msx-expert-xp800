# Contributing

Contributions are welcome when they preserve the project's photographic and legal
constraints.

## Ground rules

1. Read [`AGENTS.md`](AGENTS.md) first. WebMSX must never be vendored, bundled, proxied,
   or self-hosted; it has no declared license and is loaded only from the pinned,
   SRI-verified URL. Every visual asset must be generated procedurally in code.
2. Read [`docs/SPEC.md`](docs/SPEC.md) before changing geometry, materials, lighting, or
   interaction. If a reference photograph contradicts the spec, the photograph wins and
   the spec must change in the same contribution.
3. Preserve module isolation: modules implement `SceneModule`, own and dispose their GPU
   resources, and import only shared contracts and `MaterialLibrary`, never each other.
4. Keep TypeScript strict. Do not use `any`; use `unknown` with type guards.
5. Keep user-facing copy in Brazilian Portuguese with correct diacritics. Code,
   identifiers, and documentation use English.

## Workflow

```bash
pnpm install
pnpm dev                               # http://localhost:5173
pnpm verify                            # ast-grep + TypeScript
pnpm build
node tools/verify-interactions2.mjs   # 13 live interaction checks
node tools/verify-keymap.mjs          # every modeled key and screen source
node tools/shoot.mjs --pose hero      # inspect the result before submitting
```

Run the checks whose trigger matches your change; the complete table is in `AGENTS.md`.
Visual changes must include reviewed before/after captures from `tools/shoot.mjs`.

Use [Conventional Commits](https://www.conventionalcommits.org/) with
`feat|fix|refactor|build|ci|chore|docs|style|perf|test`. Enable the blocking ast-grep
hook in a fresh clone with `git config core.hooksPath .githooks`.
