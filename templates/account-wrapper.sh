#!/bin/sh
# builder-pipeline: wrapper v1 @NAME@
# Written by `npx builder-pipeline accounts install` from PIPELINE_PROFILE.md §16. Edit the profile and run install again; a
# local edit here is kept and named until `accounts install --force`.
# @NOTE@
name='@NAME@'
# The denylist: nothing of a parent session's Anthropic, Claude, OpenAI, Codex or Gemini setup, no Node preload, no proxy
# or CA override and no XDG config may steer this run (REQ-601, REQ-1101).
for v in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$v" in @DENYLIST@) unset "$v" ;; esac
done
@SRT_CHECK@
@KEY_CHECK@
export @DIR_VAR@='@DIR@'
@KEY_EXPORT@
@LAUNCH@
