# Contributing to margin

Thanks for your interest in contributing! margin is open-source and community-driven. Whether you're fixing a bug, adding a feature, or improving docs — you're welcome here.

## Getting Started

1. **Fork** the repository.
2. **Clone** your fork:
   ```bash
   git clone https://github.com/your-username/margin.git
   cd margin
   ```
3. **Set up the development environment** — see the [Getting Started](docs/getting-started.md) guide.

## Development

### Full stack (TanStack Start — UI + API on :3000)

```bash
npm install
npm run dev
```

API routes live in `src/routes/api.*.ts`; server-only modules live in
`src/server/`.
Run the suite with `npm run test` and typecheck with
`npx tsc --noEmit -p tsconfig.app.json` (all from the repo root).

### Code Style

- **TypeScript/React**: We use the existing project conventions. Keep components focused, prefer hooks over classes, and follow the patterns in the codebase.
- No trailing whitespace, no unnecessary comments.

## Pull Request Process

1. **Create a branch** with a descriptive name:
   - `fix/description` — for bug fixes
   - `feat/description` — for new features
   - `docs/description` — for documentation changes
2. **Keep PRs focused** — one feature/fix per PR. Large PRs are hard to review.
3. **Write a clear PR description** — what changed, why, and how to test it.
4. **Ensure the app runs** — test your changes locally before submitting.
5. **Wait for review** — we'll review as soon as possible.

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add inline diff highlighting
fix: handle empty endpoint URL on save
docs: update ai-assist troubleshooting
refactor: extract planner logic from writer
```

## Reporting Issues

- Use the [issue tracker](https://github.com/prxshetty/margin/issues).
- Include steps to reproduce, expected behavior, and screenshots if applicable.
- Mention your OS and Node version.

## Code of Conduct

This project follows the [Contributor Covenant](.github/CODE_OF_CONDUCT.md). Be respectful, constructive, and inclusive.

## Questions?

Open a [discussion](https://github.com/prxshetty/margin/discussions) or an issue. We're happy to help.
