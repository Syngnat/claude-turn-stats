# turn-stats

A Claude Code mod that shows how fast the model is actually answering: a line above the prompt with the last turn's first-token wait, output rate, token count and cache hit, and — folded out below it — the same figures averaged over the whole session.

Everything is measured on your machine. Nothing is sent anywhere.

## What it shows

Above the prompt, the turn that just finished (or the one running now):

```
⚡ 首 token 等待 1.9s · 本轮生成速度 607.3 tok/s · 本轮共 13.4k tok · 本轮缓存命中 99% · 26 步    会话统计
```

- **首 token 等待** — the wait from the request going out to the first piece of the answer arriving.
- **本轮生成速度** — the turn's output tokens over the time they were actually streamed, so the wait is not counted twice.
- **本轮缓存命中** — the share of that turn's input tokens the prompt cache served — a whole percent keeps no decimals, and one with a fraction keeps up to two.

Press **会话统计** and the session's own totals unfold underneath:

```
▎轮次 / 步数     7 轮 108 步
▎首 token 平均   2.8s
▎平均输出速度    441.4 tok/s
▎输出 token      214.8k
▎输入 token      61.2M
▎总 token        61.4M
▎缓存读取        60.6M
▎平均缓存命中    98.81%
▎上下文占用      29%
```

The token figures cover the **whole transcript**, including turns from before this mod was loaded. The averages cover the turns it measured itself, because the transcript records tokens, not how long you waited.

`/turn-stats` folds and unfolds the same block as the button.

## Install

From a Claude Code terminal session:

```
/plugin install turn-stats --marketplace Syngnat/claude-turn-stats
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every project).

From a shell instead:

```bash
claude plugin install turn-stats --marketplace Syngnat/claude-turn-stats
```

In the Claude Desktop app, where `/plugin` does not run: click **+** beside the prompt box, choose **Plugins**, then **Add marketplace** with `Syngnat/claude-turn-stats`.

Nothing else to set up: the mod starts working in that session as soon as it installs.

## Requirements

Claude Code **2.1.287** or later — mods need it, and so does everything here. In the Desktop app's Code tab, check `/status` for the Claude Code version.

**`python3` on your PATH.** The session's token totals are read from Claude Code's own transcript file, which can grow past the 4 MiB a single file read allows, so the summing runs as a small `python3` program that streams the file. macOS ships it; most Linux distributions have it.

Without `python3` the mod still loads and still shows each turn's figures — those are measured in-process. Only the session totals fall back to what the mod summed itself, which covers the turns since it loaded rather than the whole session, so they read low. It does not crash.

## How the numbers are taken

`turn.step` is the event that streams one model request. The mod timestamps the request going out and the first chunk that carries any of the answer, and the difference is the first-token wait. The output rate is the turn's `output_tokens` over the sum of its steps' streaming time.

A turn that calls tools runs the model several times; the mod sums across those steps, since what you waited for was the whole turn.

The session's token totals come from the transcript Claude Code writes (`~/.claude/projects/<project>/<session>.jsonl`), summed over every assistant response. Responses are deduplicated by their API message id: Claude Code re-stores a message as it updates it, and without the dedup the totals run high by roughly 40%.

The rate is a token-weighted mean over the session's streaming time, not the mean of the per-turn rates — a turn that produced 800 tokens in 4 s and one that produced 20 in 1 s average to 164 tok/s, not 205.

## Notes

- Subagent turns are skipped: the band reports on your conversation, not on delegated work.
- A first-token wait is taken from the first step only. Later steps in the same turn have no "you waited for the first token" moment.
- The mod keeps its numbers in the session's plugin state. Closing the app clears them, and so does `/clear`; the transcript totals rebuild themselves on the next turn.

## License

MIT — see [LICENSE](LICENSE).
