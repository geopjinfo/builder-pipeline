# Example — seam kinds for a TypeScript service with dependency injection

`typescript-di.kinds.json` is **one example** of `features.wiring.kinds` for one stack: a TypeScript service that
wires classes through a dependency-injection container, has an in-process event bus, and turns queues with async
methods. It is not installed by the pack, and nothing in the pipeline depends on these patterns. Write your own
kinds from the seams **your** code declares. The check that reads them is `npx builder-pipeline run wiring-check` (folder layout: `node scripts/wiring-check.mjs`). The rule
is in `scripts/lib/wiring.cjs`.

## Why a wiring check

In one adopting project a queue's subscribers were registered correctly, and its dispatcher had zero production
callers. Every cross-module effect was enqueued and never applied in a running deployment, across six releases. In
the same review a class was registered as a provider that nothing ever injected. Every artifact was individually
correct. Only the join was missing. A test suite cannot see that: each unit test turns the dispatcher itself, so
every test is green. No reviewer lens was looking at joins either.

A **seam** is a declaration that only means something if something else is on the other end of it. The check
inventories seams by pattern and asks, for each one, whether another production file holds the other end.

## The three kinds in this example

| Kind | Declared by | Joined when another production file… | Known limits |
|---|---|---|---|
| `motor` | a method at line start named `async dispatch*` / `drain*` / `flush*` / `pump*` / `*Batch` / `run*Cycle` (optionally `public`, `protected`, `static`, `override`) | calls it: `.name(` | `private` motors are not inventoried (their caller is their own file). Standalone `async function drainX()` is not matched. |
| `subscription` | `.subscribe('event.name', …)` | constructs the same string literal | Loose. Another subscriber's literal also joins it. Tighten `join` to your bus's emit shape, e.g. `publish\(\s*\{\s*name:\s*['"]{id}['"]`. |
| `provider` | a PascalCase name inside `providers: [ … ]` | injects or builds it: `: Name`, `new Name(`, `inject(Name` | The class's own `class Name` declaration is not a reference, on purpose. A module's own contract class, registered so a registry can reach it by token, reads UNJOINED. Rule it latent in the allow file, or narrow `declare`. |

A test file (matching `testPattern`) never declares a seam and never joins one: a motor only its own specs turn is
not a motor. The declaring file does not join its own seam unless the kind says `"scope": "any-file"`.

To use them, paste the array into §16:

```json
"wiring": {
  "state": "on",
  "roots": ["src"],
  "extensions": [".ts"],
  "testPattern": "\\.(spec|test)\\.ts$|/__tests__/",
  "allow": "scripts/wiring.allow.json",
  "kinds": [ …the entries of typescript-di.kinds.json… ]
}
```

## Lessons that came with these patterns

**"Every real motor is async" is a false-positive fix, not a law.** The first motor pattern matched `tick()` inside
an HTML template string. Requiring `async` at the start of a line removed that match, and it happened that every
real motor in that codebase was async. If your queues are turned by synchronous methods, drop the `async`
requirement and keep template strings out some other way (exclude those files from `roots`, or anchor the pattern
to a method-declaration shape).

**A shape the pattern cannot resolve is NOT-EVALUABLE.** `for (const name of NAMES) bus.subscribe(name, …)` passes a
loop variable, and no regular expression can say which event names reach it. The subscription pattern still matches
it: the second alternative matches an identifier and leaves capture 1 empty. The check then reports the seam
`not-evaluable`, counted in the PASS line. Absent evidence is never a pass and never a fail. If a count of
not-evaluable seams grows, that is a reason to write a sharper kind, not a reason to trust the zero.

**Add the kind, not the waiver.** A new kind of seam appeared (a declared configuration key that needed a reader),
and the first instinct was to add an allow row for it. But the check had no kind for configuration keys, so that
row would have matched no inventoried seam. It would still have read, in the PASS line, exactly like a live ruling.
A mandatory instrument that cannot see a seam kind reports silence, not safety. So the check fails a kind that
inventories zero seams (unless `"optional": true`), and fails a waiver that matches no unjoined seam. The fix was a
new kind, with the waiver riding on it:

```json
{ "name": "config-key", "declare": "^\\s+\\w+\\s*:\\s*'([a-z][a-z0-9_]*\\.[a-z0-9_.]+)'", "join": "getSetting\\(\\s*['\"]{id}['\"]" }
```

(Illustrative only: write it against how your own keys are declared and read.)

**A kind that skips a shape by design is blind to that shape.** The `provider` kind above reads bare class names in
`providers: [ … ]`, so a provider bound by token (`{ provide: TOKEN, useExisting: Impl }`) is never inventoried, and
"0 unjoined" says nothing about it. In the adopting project a token-bound seam was judged wired by a reviewer's
direct evidence, not by the check. The fix was again a kind: a token bound with `useExisting`, `useClass` or
`useFactory` must be injected by another production file. `useValue` (a constant handed in) and the framework's own
tokens stay out:

```json
{ "name": "provider-token", "optional": true,
  "declare": "\\{\\s*provide\\s*:\\s*(?!APP_)([A-Za-z_$][\\w$]*)\\s*,\\s*(?:useExisting|useClass|useFactory)\\b",
  "join": "@Inject\\(\\s*{id}\\s*\\)|\\binject\\s*:\\s*\\[[^\\]]*\\b{id}\\b|:\\s*{id}\\b" }
```

(`APP_` is one framework's reserved token prefix; use your container's.)

## The allow file

A JSON array of seams ruled latent — a brick deliberately ahead of its consumer:

```json
[{ "id": "drainPending", "kind": "motor", "reason": "ships ahead of the nightly job that turns it", "citation": "DECISIONS.md — STK-4" }]
```

- `reason` and `citation` are both required. A decision says why, and where it was made.
- A row that matches no unjoined seam fails: delete it once the seam is joined.
- The file only shrinks.
