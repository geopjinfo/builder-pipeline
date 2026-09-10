# Graph query block

**The one copy.** Seat briefs, persona files and the module-brief template point at this file;
nobody pastes it. A block pasted into four seats drifts four ways. And an instruction with no
runnable command is decoration: in one adopting project a "use the graph" line sat in most seat
files with no command in any of them, and the seats made no graph calls at all across dozens of
dispatches.

**Where the commands come from.** The commands below are placeholders — `<find>`, `<vocab>`,
`<explain>`, `<query>`, `<path>`, `<affected>`, `<record>`. Resolve each from your index tool, and
write the resolved forms once in the profile beside `features.graph` so every seat reads the same
ones. The optional graphify tooling (`tooling/optional/`) is one example that provides all of them;
any code graph, symbol index or embedding search that can answer these questions fits. If your tool
lacks one of them, skip that step and say so in your return line.

## What the graph is for

To **locate**: which document section, decision record, module or code symbol talks about X, and
what connects to it. **Never to rule.** The graph is a derived index; a node's source file is where
you go and read. A graph answer cited as evidence is a derived summary standing in for a source.

## 0. Is it usable right now?

Your brief carries the index verdict from step 0 of the pipeline (`node scripts/index-check.mjs`).

| Verdict (exit code) | Do |
|---|---|
| fresh (`0`) | use this block |
| docs pending / code behind (`10`, `11`, `12`) | use it; the lagging side may miss the newest change — verifying at source (step 3) covers it |
| absent or not configured (`3`), unmeasurable (`4`), error (`1`), or no verdict in your brief | skip this block; locate with plain search |

## 1. Find the exact label first (required)

Most graph tools match node **labels** literally — no stemming, no synonyms. A paraphrase returns
noise or nothing, and it does so silently. So start from the graph's own words:

```
<find> "<term>"          # exact labels containing the term, with their source file
<vocab> "<stem>"         # the label vocabulary containing a stem
```

## 2. Ask with those labels

```
<explain> "<exact label>"                 # the node and everything linked to it
<query> "<label tokens>"                  # the neighbourhood of several labels, within a budget
<path> "<label A>" "<label B>"            # how two things connect
<affected> "<label of a changed symbol>"  # auditors: what the diff reaches
```

Cap your graph calls per dispatch — your brief may set the number; if it does not, six. The same
question dead-ending twice means switch to plain search.

## 3. Verify at the source before citing

Open the source file the graph named and cite the `file:line` **you read**. Never cite a node, an
edge or a query output.

## 4. Record the outcome — every question

Record each question with your tool's `<record>` command, or in your own notes if it has none:
the question, a one-line answer, the labels used, and the outcome. `useful` = it pointed you at the
source you then cited. `dead_end` = nothing relevant, or wrong.

## 5. Say it in your return

End your final message with exactly one line:

```
graph: <calls> calls, <useful> useful, <dead_end> dead-end
```

or `graph: not used — <reason>` when you skipped the block. The graph's usefulness is judged on these
lines checked against the harness's own records of the calls where it keeps them — never on
impressions (`EXPERIMENTS.md`, graph seat trial).
