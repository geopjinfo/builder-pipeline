#!/bin/sh
# commit-msg — commits carry human authors only: strip AI attribution from the message.
#
# Removes an agent's co-author trailer (a Co-Authored-By line naming Claude, Fable, Opus, Sonnet, Haiku, Codex,
# Copilot, Cursor, Gemini, Antigravity, ChatGPT or GPT, or an @anthropic.com / @openai.com address) and the
# "Generated with <agent>" advert line, then closes the blank-line gaps they leave. A human co-author is kept. It runs
# for every commit, from any tool or person, whatever an agent's own instructions tell it to append — the rule lives
# here, not in goodwill. Never blocks a commit: on any error the message is left as it was.
#
# Arm it (each clone; git hooks are not pushed): `npx --no-install builder-pipeline git-hooks` copies it to the repository's hooks folder
# (core.hooksPath when set, else .git/hooks) and never overwrites a commit-msg hook already there.
# (folder layout: node builder/cli.js git-hooks)

msg_file="$1"
[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0
tmp_file="$msg_file.no-ai"

AGENT='([Cc]laude|[Ff]able|[Oo]pus|[Ss]onnet|[Hh]aiku|[Cc]odex|[Cc]opilot|[Cc]ursor|[Gg]emini|[Aa]ntigravity|[Cc]hat[Gg][Pp][Tt]|GPT-?[0-9]|@anthropic\.com|@openai\.com)'

if sed -E \
  -e "/^[[:space:]]*[Cc]o-[Aa]uthored-[Bb]y:.*${AGENT}/d" \
  -e '/^[[:space:]]*(🤖[[:space:]]*)?[Gg]enerated (with|by) \[?(Claude|Codex|Copilot|Cursor|Gemini|Antigravity|ChatGPT)/d' \
  "$msg_file" | awk '
    /^[[:space:]]*$/ { blank++; next }
    { if (out && blank) print ""; blank = 0; out = 1; print }
  ' > "$tmp_file"; then
  # An emptied message is git's to refuse ("Aborting commit due to empty commit message"), never ours to invent.
  mv "$tmp_file" "$msg_file"
else
  rm -f "$tmp_file"
fi
exit 0
