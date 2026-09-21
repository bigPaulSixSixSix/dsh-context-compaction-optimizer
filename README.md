# dsh-context-compaction-optimizer

Mark a conversation turn as **invalid** so a DSH compaction leaves it out of the
checkpoint — without deleting anything from the session.

A compaction summarizes an earlier span of a conversation and replaces it with a
checkpoint. Everything in that span is summarized, including the tangents,
dead ends and pasted material that were never worth remembering. This plugin lets
an operator mark those exchanges, and tells the summarizing model to treat them as
if they had never been written.

It works by **marking, never deleting**. No message is removed, reordered or
rewritten, so the provider's prefix cache still hits and a compaction costs
approximately what it did before.

---

## What it does not promise

Read this before relying on it. These are measured limits, not disclaimers.

- **Exclusion is not absolute.** The checkpoint is written by a language model
  following an instruction, and that model sometimes does not comply. In measured
  runs, a marked turn's *content* disappeared entirely while an incidental URL
  survived; in another, an entire marked turn was summarized as if it had not
  been marked.
- **It fails in two shapes, and which one you get is not predictable.** Either the
  exclusion **does not run at all** — the whole turn is summarized normally
  (measured on a fixture where the marked content was the conversation's
  substance) — or it runs and **details from the excluded turn still surface**.
  What surfaces varies: the current rendering leaked a single URL domain, while
  the previous rendering leaked an entire identification on the same fixture
  (book title, translator, edition, four links). Neither run quoted any prose
  verbatim.
- **So if a turn's conclusion is itself wrong, do not count on exclusion to
  contain it** — the checkpoint can still inherit it.
- **The most recent exchange is never summarized.** DSH retains the recent
  context verbatim and never sends it to the summarizer, so marking a turn inside
  that retained tail has no effect. The panel states this up front and, after a
  compaction, reports which marks did not take effect.
- **Marking changes only what a compaction absorbs.** It does not alter when a
  compaction happens, what range it covers, or the compaction algorithm.

---

## Install

```sh
dsh plugin --profile <profile> add dsh-context-compaction-optimizer
```

The plugin installs as a **real bundle**, so it arrives through the package's own
`cordis.patch.yml`. Do **not** also add a mount row to your profile patch — that
loads the host half twice, registers two stream listeners, and injects the digest
twice.

Restart the host after installing; the host half is loaded at process start.

---

## Using it

**Marking**

1. **The quick action under a reply** marks that turn directly.
2. **The button in the session header** opens the turn list, where any turn can be
   reviewed and marked. One row per turn; **▸** expands a turn's full step list
   (read-only).

**Triggering**

1. **Automatic** — the marks take effect whenever DSH runs a compaction.
2. **Manual** — run `/cco-compact` in the composer, or press **Compact now** at
   the bottom of the panel.

Marking itself triggers nothing. Both entry points act on the same unit — the
turn — so they cannot disagree.

---

## Settings

Under **Settings → Plugins → Compaction optimizer**.

| Setting | Default | Meaning |
| :--- | :--- | :--- |
| Inject annotations into compaction | on | Master switch. Off means marking has no effect. |
| Treat unmarked messages as invalid | **off** | Applies the exclusion to messages nobody annotated. With this on, a conversation you never annotated excludes everything. |
| Record cache accounting | off | Keeps token and cache-hit readings per compaction for diagnostics. |

One further key is settable in `$DSH_HOME/settings.yaml` but has no switch, because
it selects between two internal renderings of the same exclusion set and there is
nothing for an operator to decide:

```yaml
context-compaction-optimizer:
  digestFormat: spans   # or: anchors
```

---

## How it works

1. Annotations are stored per message (`sessionId` + `messageId`) in a DSH storage
   domain. A turn's mark is one write across that turn's messages.
2. When a compaction runs, the plugin appends a short **digest** to the
   summarization request, immediately **before** the compaction instruction.
3. Every message ahead of that point keeps its exact position, so the provider's
   prefix cache still hits. The digest is the only uncached input it adds —
   measured at roughly its own length.
4. The digest names the excluded messages by position, role and a verbatim
   opening, and asks the model to treat them as never written.

**The unit is the turn**: annotations are stored per message, but review and
action are grouped as "your message plus everything the agent did about it" — a
turn routinely spans dozens of messages, so marking per message would ask for a
dozen clicks to express one judgement.

---

## Development

```sh
npm test        # unit + contract suites; no external dependencies
npm run build   # emits lib/index.js and lib/client.js
npm run smoke   # live mount check against a running host (http://127.0.0.1:3080)
npm run measure # cache/leak report from existing session logs
```

`npm test` runs without a build and without a host. `npm run smoke` requires a
running DSH and is the post-install verification step.

---

## Compatibility

- DSH `0.1.5-rc.*`, Node.js 20+.
- Depends on the harness's `llm/stream` waterfall and the agent preset roster.
- **Does not** replace or subclass `compaction-basic`; it is backend-independent
  and coexists with the stock compaction stack.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE).
