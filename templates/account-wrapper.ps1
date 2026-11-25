# builder-pipeline: wrapper v1 @NAME@
# Written by `npx --no-install builder-pipeline accounts install` from PIPELINE_PROFILE.md §16. Edit the profile and run install again; a
# local edit here is kept and named until `accounts install --force`.
# @NOTE@
$name = '@NAME@'
# The denylist (REQ-601, REQ-1101): nothing of a parent session's setup steers this run.
foreach ($v in Get-ChildItem Env: | Select-Object -ExpandProperty Name) {
  if ($v -match '@DENYLIST_RE@') { Remove-Item -ErrorAction SilentlyContinue "Env:$v" }
}
@SRT_CHECK@
@KEY_CHECK@
$env:@DIR_VAR@ = '@DIR@'
@KEY_EXPORT@
@LAUNCH@
exit $LASTEXITCODE
