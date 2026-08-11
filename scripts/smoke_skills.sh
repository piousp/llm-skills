#!/usr/bin/env bash
# Smoke test: each pablo-* skill's scripts/pi_session.py symlink must resolve
# to the canonical session working directory, through both the repo path and
# the ~/.pi/agent/skills path (the one the agent actually uses).
#
# Requires PI_SESSION_FILE and PI_SESSION_ID (set automatically inside pi).
set -u
: "${PI_SESSION_FILE:?set PI_SESSION_FILE (run inside pi) or export it}"
: "${PI_SESSION_ID:?set PI_SESSION_ID (run inside pi) or export it}"

expected=$(python3 /home/pablo/LLMs/scripts/pi_session.py) || { echo "FAIL canonical script"; exit 1; }
echo "expected: $expected"

fail=0
for s in pablo-goal-discovery pablo-code-philosophy pablo-code-planning pablo-tdd pablo-toolkit; do
  real=$(python3 "/home/pablo/LLMs/skills/$s/scripts/pi_session.py" 2>&1)
  link=$(python3 "$HOME/.pi/agent/skills/$s/scripts/pi_session.py" 2>&1)
  if [ "$real" = "$expected" ] && [ "$link" = "$expected" ]; then
    echo "PASS $s"
  else
    echo "FAIL $s real=[$real] link=[$link]"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "SMOKE-DONE-ALL-PASS"
else
  echo "SMOKE-DONE-WITH-FAILURES"
fi
exit "$fail"
