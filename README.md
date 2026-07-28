# Token Planner

A step-by-step planner for design token systems. Work through ten guided steps,
watch a live preview paint itself with your own tokens, then export either a
ready-to-paste **Figma CLI prompt** or **Token Studio JSON**.

Built with Vite, React 18 and TypeScript. The whole application lives in a
single `src/App.tsx` by design.

---

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot module replacement |
| `npm run build` | Type-checks with `tsc --noEmit`, then bundles to `dist/` |
| `npm run preview` | Serves the production build locally |
| `npm run typecheck` | Type-check only, no bundle |

`npm run build` fails on any type error, so a broken build never reaches Vercel.

---

## Deploying to Vercel

The repo ships a `vercel.json`, so no dashboard configuration is needed.

**From the dashboard:** push to GitHub, then *Add New Project* → import the
repo. Vercel detects Vite and uses `npm run build` → `dist/`.

**From the CLI:**

```bash
npm i -g vercel
vercel          # preview deployment
vercel --prod   # production deployment
```

The included rewrite rule sends every path back to `index.html`, so the app
keeps working if you later add client-side routing.

---

## Project structure

```
.
├── index.html            # Vite entry document
├── package.json
├── tsconfig.json         # app config — type-check only, Vite handles emit
├── tsconfig.node.json    # config for vite.config.ts itself
├── vite.config.ts
├── vercel.json           # framework, build command, SPA rewrite
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx          # React root
    ├── vite-env.d.ts
    └── App.tsx           # the entire application
```

### Inside `App.tsx`

The file is ordered so it reads top to bottom, with a map in the header comment:

| Section | Contents |
| --- | --- |
| 0 | Domain model — every interface the wizard document is built from |
| 1–2 | Utilities and validators (pure, no React) |
| 3–4 | Default scales and wizard configuration |
| 5–6 | Auto-mapping and the prompt / JSON generators |
| 7 | Stylesheet |
| 7b | Theme system |
| 8 | UI primitives |
| 8b | Project persistence |
| 9 / 9b | Composite editors and the live preview |
| 10 | The ten steps |
| 11 | App shell, error boundary |

Sections 0–6 and 8b are pure TypeScript with no React dependency. If the file
ever needs splitting, those lift out unchanged.

---

## Notable design decisions

**The stylesheet is a token system.** Tier 1 is a raw neutral ramp authored
twice, once per theme. Tier 2 maps it to semantic roles. Tier 3 — every
component rule — reads Tier 2 only and contains no raw colour values. Switching
theme swaps Tier 1 alone.

**Theme.** Light, dark and system. The resolved value is written to
`<html data-tp-theme>`, and a `matchMedia` listener keeps *system* live.

**Persistence.** One versioned envelope serves autosave, *Export project* and
*Import project*, so a file exported months ago restores exactly like a browser
session. Import merges onto a fresh default and cannot throw — truncated or
hand-edited files degrade to defaults rather than crashing.

**Storage is optional.** `localStorage` is wrapped with an in-memory fallback,
so the app still runs where storage is blocked; the save indicator switches to
*Not saved* and suggests exporting instead.

---

## TypeScript strictness

`strict` is deliberately off in `tsconfig.json`. The domain model in section 0
is fully typed and the compiler already catches real mistakes at the boundaries
that matter. To tighten further, enable one flag at a time:

```jsonc
"noImplicitAny": true,   // then annotate remaining callback params
"strictNullChecks": true // then audit ref access and optional fields
```

---

## Browser support

Modern evergreen browsers. The build targets ES2020.
